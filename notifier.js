'use strict';
/*
 * Optional operator and trader alerts through Telegram. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.
 * It sends: high-impact release reminders (30 min ahead), data sources failing or recovering,
 * and the release schedule running out. Without both variables nothing is sent.
 */
function makeNotifier(opts) {
  const o = opts || {};
  if (!o.token || !o.chatId) return null;
  const f = o.fetch || fetch;
  return {
    async notify(text) {
      const res = await f('https://api.telegram.org/bot' + o.token + '/sendMessage', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: o.chatId, text: String(text).slice(0, 3500) }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error('telegram HTTP ' + res.status); // the token is never included in the message
    },
  };
}
module.exports = { makeNotifier };
