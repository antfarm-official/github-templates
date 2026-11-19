const https = require('node:https');
const fs = require('node:fs');

// Slack message timestamps are strictly `seconds.microseconds` with exactly 6
// fractional digits (e.g. `1234567890.123456`). Reject anything else before
// writing to GITHUB_OUTPUT so a poisoned API response cannot inject extra keys.
const isValidSlackTs = (ts) =>
    typeof ts === 'string' && /^\d{10}\.\d{6}$/.test(ts);

// Convert GitHub Markdown to Slack mrkdwn
const markdownToMrkdwn = (text) => {
    return (
        text
            // Convert links: [text](url) -> <url|text>
            .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>')
            // Convert bold: **text** -> *text* (mrkdwn renders ** literally)
            .replace(/\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*/g, '*$1*')
            // Convert headers: ## Header -> *Header*
            .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
            // Convert list items, either marker, any nesting: - item / * item -> • item
            .replace(/^(\s*)[-*]\s+/gm, '$1• ')
    );
};

// chat.update rejects `text` over 4,000 UTF-8 bytes (`msg_too_long`), not
// characters: a changelog of `•` bullets (3 bytes each) fails well under 4,000
// characters. The body is cut at the last line break that fits, so no mrkdwn
// link is split, and the cut is marked — with a link to the full text (the PR,
// the GitHub release) when the caller passes one. A short closing paragraph
// survives the cut: release flags such as the DB-migration warning live there.
const MAX_TEXT_BYTES = 4000;
const MAX_KEPT_TAIL_BYTES = 500;
const TRUNCATION_MARK = '\n… (truncated)';

const byteLength = (text) => Buffer.byteLength(text, 'utf8');

// The longest prefix of `text` within `bytes` UTF-8 bytes, without a split code point.
const fitBytes = (text, bytes) => {
    let prefix = Buffer.from(text, 'utf8')
        .subarray(0, Math.max(bytes, 0))
        .toString('utf8');
    while (!text.startsWith(prefix)) {
        prefix = prefix.slice(0, -1);
    }
    return prefix;
};

const truncationMark = (cutLink) =>
    cutLink ? `\n… the rest is in ${cutLink}` : TRUNCATION_MARK;

const truncateText = (text, limit = MAX_TEXT_BYTES, mark = TRUNCATION_MARK) => {
    if (byteLength(text) <= limit) {
        return text;
    }
    const trimmed = text.trimEnd();
    if (byteLength(trimmed) <= limit) {
        return trimmed;
    }
    const tailStart = trimmed.lastIndexOf('\n\n');
    const tail =
        tailStart > 0 && byteLength(trimmed.slice(tailStart)) <= MAX_KEPT_TAIL_BYTES
            ? trimmed.slice(tailStart)
            : '';
    const head = fitBytes(trimmed, limit - byteLength(mark) - byteLength(tail));
    const lineEnd = trimmed.lastIndexOf('\n', head.length);
    return `${lineEnd > 0 ? trimmed.slice(0, lineEnd) : head}${mark}${tail}`;
};

// Sanitize untrusted values before logging to avoid log-forging/control chars.
const sanitizeForLog = (value) =>
    String(value ?? '')
        .replace(/[\r\n]+/g, ' ')
        .replace(/[\x00-\x1F\x7F]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

// Posts a new message, or edits an existing one when `updateTs` is set
// (chat.update) — used to reflect lifecycle status (started → cancelled →
// completed) in the release's head message rather than only as thread replies.
const sendMessage = (token, channel, text, threadTs, updateTs) =>
    new Promise((resolve, reject) => {
        const isUpdate = Boolean(updateTs);
        const payload = isUpdate
            ? { channel, ts: updateTs, text }
            : { channel, text };
        if (!isUpdate && threadTs) {
            payload.thread_ts = threadTs;
        }

        const data = JSON.stringify(payload);

        const options = {
            hostname: 'slack.com',
            port: 443,
            path: isUpdate ? '/api/chat.update' : '/api/chat.postMessage',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
                'Content-Length': Buffer.byteLength(data),
            },
        };

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        const parsed = JSON.parse(body);
                        if (parsed.ok) {
                            resolve(parsed.ts);
                        } else {
                            reject(
                                new Error(`Slack API error: ${parsed.error}`),
                            );
                        }
                    } catch (e) {
                        reject(new Error('Failed to parse Slack response', e));
                    }
                } else {
                    reject(
                        new Error(`Slack request failed: ${res.statusCode}`),
                    );
                }
            });
        });

        req.on('error', (e) => reject(e));
        req.write(data);
        req.end();
    });

module.exports = { isValidSlackTs, markdownToMrkdwn, truncateText, truncationMark };

// Standalone runner
if (require.main === module) {
    const token = process.env.SLACK_BOT_TOKEN;
    const channel = process.env.SLACK_CHANNEL_ID;
    const threadTs = process.env.SLACK_THREAD_TS;
    const updateTs = process.env.SLACK_UPDATE_TS;

    // Get message from args (3rd arg)
    const message = process.argv[2];

    if (!(token && channel)) {
        console.log('Skipping Slack notification: Missing token or channel.');
        process.exit(0);
    }

    if (!message) {
        console.error('Missing message argument.');
        process.exit(1);
    }

    console.log('Sending Slack notification.');

    const text = markdownToMrkdwn(message);
    const cutLink = markdownToMrkdwn(process.env.SLACK_CUT_LINK || '').trim();
    const fittedText = truncateText(text, MAX_TEXT_BYTES, truncationMark(cutLink));
    if (byteLength(fittedText) < byteLength(text.trimEnd())) {
        console.log(
            `::warning::Slack message truncated from ${byteLength(text)} to ${byteLength(fittedText)} bytes.`,
        );
    }

    sendMessage(token, channel, fittedText, threadTs, updateTs)
        .then((ts) => {
            if (!isValidSlackTs(ts)) {
                console.error('Slack returned an invalid ts.');
                process.exit(1);
            }
            console.log('Message sent.');
            const outputFile = process.env.GITHUB_OUTPUT;
            if (outputFile) {
                fs.appendFileSync(outputFile, `ts=${ts}\n`);
            } else {
                console.log(`::set-output name=ts::${ts}`);
            }
        })
        .catch((error) => {
            const safeErrorMessage = sanitizeForLog(error?.message ?? error);
            console.error(`Failed to send Slack message: ${safeErrorMessage}`);
            process.exit(1);
        });
}
