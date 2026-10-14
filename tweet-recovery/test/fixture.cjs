// X のタイムラインの DOM 構造 (data-testid など) を真似たテスト用ページを作る

const svg = (color, label = '') =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="${color}"/><text x="80" y="55" font-size="32" text-anchor="middle" fill="#fff">${label}</text></svg>`,
  )}`;

const COLORS = ['#e0245e', '#17bf63', '#794bc4', '#f45d22', '#1d9bf0', '#ffad1f'];
const emoji = (ch) => `<img alt="${ch}" draggable="false" src="${svg('#ffcc4d')}" style="width:1.2em;height:1.2em;vertical-align:-0.2em">`;

function userName({ nameHtml, handle, id, time, ad, inQuote }) {
  // 引用内のユーザー名はリンクではなく、時刻もパーマリンクになっていない
  const name = `<div><span><span>${nameHtml}</span></span></div>`;
  const nameBox = inQuote ? `<div><div>${name}</div></div>` : `<div><div><a href="/${handle}" role="link">${name}</a></div></div>`;
  const handleEl = inQuote
    ? `<div><span>@${handle}</span></div>`
    : `<div><a href="/${handle}" role="link" tabindex="-1"><div><span>@${handle}</span></div></a></div>`;
  let timeEl = '';
  if (ad) timeEl = '<div><span>プロモーション</span></div>';
  else if (inQuote) timeEl = `<div><time datetime="${time}">1日</time></div>`;
  else timeEl = `<div><a href="/${handle}/status/${id}" role="link"><time datetime="${time}">2時間</time></a></div>`;
  return `<div data-testid="User-Name">${nameBox}<div><div>${handleEl}<div><span>·</span></div>${timeEl}</div></div></div>`;
}

function article(t, i) {
  const color = COLORS[i % COLORS.length];
  const quote = t.quote
    ? `<div role="link" tabindex="0" style="border:1px solid #ccc;border-radius:12px;padding:8px;margin-top:8px">
        ${userName({ ...t.quote, inQuote: true, time: '2024-04-30T10:00:00.000Z' })}
        <div data-testid="tweetText" lang="ja"><span>${t.quote.textHtml}</span></div>
      </div>`
    : '';
  return `
  <div data-testid="cellInnerDiv">
    <article data-testid="tweet" role="article" tabindex="0" data-fixture-id="${t.id || 'ad'}"
      style="min-height:${t.height || 260}px;padding:12px 16px;border-bottom:1px solid #eee;box-sizing:border-box">
      ${t.context ? `<div><span data-testid="socialContext">${t.context}</span></div>` : ''}
      <div data-testid="Tweet-User-Avatar"><img src="${svg(color, (t.handle || '?')[0].toUpperCase())}" width="40" height="40" style="border-radius:50%"></div>
      ${userName(t)}
      <div data-testid="tweetText" lang="ja"><span>${t.textHtml}</span></div>
      ${t.truncated ? '<button data-testid="tweet-text-show-more-link">さらに表示</button>' : ''}
      ${t.photo ? `<div data-testid="tweetPhoto"><img src="${svg(color, '写真')}" width="320"></div>` : ''}
      ${quote}
    </article>
  </div>`;
}

const tweet = (id, handle, nameHtml, textHtml, extra = {}) => ({
  id: String(id),
  handle,
  nameHtml,
  textHtml,
  time: '2024-05-01T03:00:00.000Z',
  ...extra,
});

// 更新前のタイムライン
const TIMELINE_A = [
  tweet('1790000000000000001', 'sunny_day', `さにー${emoji('☀️')}`, 'おはようございます。今日もいい天気ですね'),
  tweet('1790000000000000002', 'funny_cat', 'おもしろ猫', `これは笑った${emoji('😂')}`, { context: 'たなかさんがリポストしました' }),
  { handle: 'ad_brand', nameHtml: '広告ブランド', textHtml: '今だけ半額！', ad: true },
  tweet('1790000000000000003', 'quoter', '引用する人', 'これ本当にそう', {
    quote: { handle: 'quoted_user', nameHtml: '引用元の人', textHtml: '引用されたツイートの本文' },
  }),
  tweet('1790000000000000004', 'cat_photo', 'ねこ写真', 'うちのねこです', { photo: true }),
  tweet('1790000000000000005', 'long_writer', '長文の人', '長い文章の書き出しです。続きは「さらに表示」で', { truncated: true }),
  tweet('1790000000000000006', 'zukai_master', '図解マスター', '神ツイート：締め切り前日にやる気が出る理由を図解しました', {
    photo: true,
    height: 560,
  }),
  ...Array.from({ length: 6 }, (_, i) =>
    tweet(String(1790000000000000100n + BigInt(i)), `user_${i}`, `ユーザー${i}`, `タイムラインのツイート ${i}`),
  ),
];

// 更新後のタイムライン (さっきまでのツイートはもう出てこない)
const TIMELINE_B = Array.from({ length: 8 }, (_, i) =>
  tweet(String(1790000000000000200n + BigInt(i)), `fresh_${i}`, `新着${i}`, `リロード後のツイート ${i}`),
);

function page(tweets, { dark = false } = {}) {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ホーム / X</title>
<style>
  body { margin: 0; font: 15px/1.4 sans-serif; background: ${dark ? '#000' : '#fff'}; color: ${dark ? '#e7e9ea' : '#0f1419'}; }
  main { max-width: 600px; margin: 0 auto; border-left: 1px solid #eee; border-right: 1px solid #eee; }
  [data-testid="tweetText"] { margin: 6px 0; }
</style></head>
<body>
  <div id="react-root"><main><div aria-label="タイムライン: ホームタイムライン">${tweets.map(article).join('')}</div></main></div>
  <script>
    // X のキーボードショートカットの代わり。パネルでの入力がここまで届いたらテスト失敗
    window.__xKeys = [];
    document.addEventListener('keydown', (e) => window.__xKeys.push(e.key));
  </script>
</body></html>`;
}

module.exports = { TIMELINE_A, TIMELINE_B, page };
