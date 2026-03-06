// ntfy.sh alert integration for APEX scanner

/**
 * Send an alert via ntfy.sh
 * @param {Object} opts
 * @param {string} opts.title - Alert title
 * @param {string} opts.body - Alert body
 * @param {string} opts.topic - ntfy.sh topic name
 * @param {string} [opts.priority='high'] - Priority: urgent, high, default, low, min
 * @param {string[]} [opts.tags] - Emoji tags (e.g., ['chart_with_downwards_trend', 'warning'])
 */
async function sendAlert({ title, body, topic, priority = 'high', tags = [] }) {
    if (!topic) {
        console.warn('No ntfy topic configured — skipping alert');
        return;
    }

    const headers = {
        'Title': title,
        'Priority': priority
    };
    if (tags.length > 0) {
        headers['Tags'] = tags.join(',');
    }

    try {
        const res = await fetch(`https://ntfy.sh/${topic}`, {
            method: 'POST',
            headers,
            body
        });
        if (res.ok) {
            console.log(`Alert sent: ${title}`);
        } else {
            console.error(`Alert failed (${res.status}): ${await res.text()}`);
        }
    } catch (err) {
        console.error('Alert send error:', err.message);
    }
}

module.exports = { sendAlert };
