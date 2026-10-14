// 本物の Chromium で x.com を模したページを開き、記録・検索・スターなどを一通り確かめる。
//   npm install && npm test
// 結果のスクリーンショットは test/output/ に出る。

const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TIMELINE_A, TIMELINE_B, page: pageHtml } = require('./fixture.cjs');

const EXT_DIR = path.resolve(__dirname, '../extension');
const SCRIPT = path.join(EXT_DIR, 'tweet-recovery.user.js');
const OUT = path.join(__dirname, 'output');
const GOOD_ID = TIMELINE_A[6].id;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let step = 0;
async function check(name, fn) {
  step += 1;
  process.stdout.write(`${step}. ${name} ... `);
  await fn();
  console.log('ok');
}

// x.com へのリクエストを横取りして、テスト用のタイムラインを返す
async function serveX(context, state) {
  await context.route(/^https:\/\/x\.com\//, (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: pageHtml(state.tweets, state) }),
  );
}

async function openX(page, { inject = true } = {}) {
  await page.goto('https://x.com/home');
  if (inject) await page.addScriptTag({ path: SCRIPT });
  await page.locator('#tweet-recovery-root').waitFor({ state: 'attached' });
}

function readDb(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('tweet-recovery');
        req.onsuccess = () => {
          const db = req.result;
          const all = db.transaction('tweets').objectStore('tweets').getAll();
          all.onsuccess = () => {
            db.close();
            resolve(Object.fromEntries(all.result.map((t) => [t.id, t])));
          };
          all.onerror = () => reject(all.error);
        };
        req.onerror = () => reject(req.error);
      }),
  );
}

// 1 秒ごとの書き込みを待ってから DB を読む
async function settle(page) {
  await wait(1300);
  return readDb(page);
}

async function scrollThrough(page) {
  // 人がスクロールするように少しずつ下へ。図解ツイートでは手を止めてじっくり読む
  const height = await page.evaluate(() => document.body.scrollHeight);
  let stopped = false;
  for (let y = 0; y < height; y += 200) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await wait(150);
    if (!stopped) {
      const reached = await page.evaluate(
        (id) => document.querySelector(`[data-fixture-id="${id}"]`).getBoundingClientRect().top < 300,
        GOOD_ID,
      );
      if (reached) {
        stopped = true;
        await page.evaluate((id) => document.querySelector(`[data-fixture-id="${id}"]`).scrollIntoView({ block: 'center' }), GOOD_ID);
        await wait(4000);
      }
    }
  }
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await wait(800);
}

const items = (page) => page.locator('#tweet-recovery-root .item');
const itemTexts = (page) => page.locator('#tweet-recovery-root .item .main > .link > .text').allInnerTexts();

async function userscriptSuite(browser) {
  const state = { tweets: TIMELINE_A, dark: false };
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ja-JP', acceptDownloads: true });
  await serveX(context, state);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err));
  page.on('dialog', (d) => d.accept());

  await openX(page);

  await check('二重に読み込んでも 1 つしか動かない', async () => {
    await page.addScriptTag({ path: SCRIPT });
    assert.equal(await page.locator('#tweet-recovery-root').count(), 1);
  });

  await check('画面に入る前のツイートは記録しない', async () => {
    const db = await settle(page);
    assert.ok(db[TIMELINE_A[0].id], '最初のツイートは見えているので記録される');
    assert.equal(db[TIMELINE_A.at(-1).id], undefined, '一番下のツイートはまだ見ていない');
  });

  await scrollThrough(page);
  const db = await settle(page);

  await check('スクロールで表示したツイートが全部記録される (広告は除く)', async () => {
    for (const t of TIMELINE_A.filter((t) => !t.ad)) assert.ok(db[t.id], `${t.handle} が記録されていない`);
    assert.ok(!Object.values(db).some((t) => t.handle === 'ad_brand'), '広告が記録されている');
  });

  await check('名前・本文・絵文字・リポスト・引用・画像・省略を正しく読み取る', async () => {
    const [sunny, rt, quote, photo, long] = [0, 1, 3, 4, 5].map((i) => db[TIMELINE_A[i].id]);
    assert.equal(sunny.name, 'さにー☀️');
    assert.equal(sunny.handle, 'sunny_day');
    assert.equal(sunny.text, 'おはようございます。今日もいい天気ですね');
    assert.equal(sunny.time, '2024-05-01T03:00:00.000Z');
    assert.equal(sunny.seenOn, '/home');
    assert.ok(sunny.avatar.startsWith('data:image/svg+xml'));
    assert.equal(rt.text, 'これは笑った😂');
    assert.equal(rt.context, 'たなかさんがリポストしました');
    assert.equal(quote.text, 'これ本当にそう', '引用元の本文が混ざっている');
    assert.deepEqual(quote.quote, { name: '引用元の人', handle: 'quoted_user', text: '引用されたツイートの本文' });
    assert.equal(photo.media.length, 1);
    assert.equal(long.truncated, true);
    assert.equal(sunny.truncated, false);
  });

  await check('手を止めて読んだツイートの表示時間が一番長い', async () => {
    const sorted = Object.values(db).sort((a, b) => b.dwellMs - a.dwellMs);
    assert.equal(sorted[0].id, GOOD_ID);
    assert.ok(sorted[0].dwellMs >= 3500, `表示時間が短すぎる: ${sorted[0].dwellMs}ms`);
  });

  // ここでタイムラインを更新してしまう
  state.tweets = TIMELINE_B;
  await openX(page);
  await wait(500);

  await check('更新したらさっきのツイートは画面から消えている', async () => {
    assert.equal(await page.locator(`[data-fixture-id="${GOOD_ID}"]`).count(), 0);
  });

  await check('Alt+Shift+H でパネルが開き、さっきのツイートが見た順に並ぶ', async () => {
    await page.keyboard.press('Alt+Shift+H');
    await page.locator('#tweet-recovery-root .panel').waitFor({ state: 'visible' });
    await page.locator('#tweet-recovery-root .item').first().waitFor();
    const texts = await itemTexts(page);
    assert.ok(texts[0].startsWith('リロード後のツイート'), `先頭は今見ているもの: ${texts[0]}`);
    const lastOfA = texts.indexOf('タイムラインのツイート 5');
    const firstOfA = texts.indexOf('おはようございます。今日もいい天気ですね');
    assert.ok(lastOfA !== -1 && firstOfA !== -1, '更新前のツイートが一覧にない');
    assert.ok(lastOfA < firstOfA, '後に見たものほど上に来ていない');
    assert.match(await page.locator('#tweet-recovery-root .count').innerText(), /^\d+件$/);
  });

  await check('パネルの検索欄への入力は X のショートカットに届かない', async () => {
    await page.evaluate(() => {
      window.__xKeys = [];
    });
    await page.locator('#tweet-recovery-root input[type="search"]').pressSequentially('jkl');
    await page.locator('#tweet-recovery-root input[type="search"]').fill('');
    assert.deepEqual(await page.evaluate(() => window.__xKeys), []);
  });

  await check('「表示時間が長い順」で図解ツイートが先頭に来る', async () => {
    await page.locator('#tweet-recovery-root select[aria-label="並び順"]').selectOption('dwell');
    await page.waitForFunction(
      () => document.querySelector('#tweet-recovery-root').shadowRoot.querySelector('.item .text')?.textContent.startsWith('神ツイート'),
    );
  });

  await check('キーワードで絞り込める (全角・半角も区別しない)', async () => {
    await page.locator('#tweet-recovery-root input[type="search"]').fill('図解 ＠ZUKAI_master');
    await page.waitForFunction(() => document.querySelector('#tweet-recovery-root').shadowRoot.querySelectorAll('.item').length === 1);
    assert.match((await itemTexts(page))[0], /^神ツイート/);
    await page.locator('#tweet-recovery-root input[type="search"]').fill('引用されたツイート');
    await page.waitForFunction(() => {
      const list = document.querySelector('#tweet-recovery-root').shadowRoot.querySelectorAll('.item .main > .link > .text');
      return list.length === 1 && list[0].textContent === 'これ本当にそう';
    });
    await page.locator('#tweet-recovery-root input[type="search"]').fill('');
    await page.waitForFunction(() => document.querySelector('#tweet-recovery-root').shadowRoot.querySelectorAll('.item').length > 10);
  });

  await check('ツイートへのリンクが正しい', async () => {
    const href = await items(page).first().locator('a.link').getAttribute('href');
    assert.equal(href, `https://x.com/zukai_master/status/${GOOD_ID}`);
  });

  await check('★を付けると保存される', async () => {
    await items(page).first().locator('button.star').click();
    await wait(300);
    assert.equal((await readDb(page))[GOOD_ID].starred, 1);
    await page.locator('#tweet-recovery-root .check', { hasText: '★のみ' }).click();
    await page.waitForFunction(() => document.querySelector('#tweet-recovery-root').shadowRoot.querySelectorAll('.item').length === 1);
    await page.locator('#tweet-recovery-root .check', { hasText: '★のみ' }).click();
    await page.waitForFunction(() => document.querySelector('#tweet-recovery-root').shadowRoot.querySelectorAll('.item').length > 1);
  });

  await check('スクリーンショット (PC)', async () => {
    await page.locator('#tweet-recovery-root select[aria-label="並び順"]').selectOption('recent');
    await wait(300);
    await page.screenshot({ path: path.join(OUT, 'panel-desktop.png') });
  });

  let exported;
  await check('エクスポートで全件を JSON に書き出せる', async () => {
    await page.locator('#tweet-recovery-root summary').click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'エクスポート' }).click()]);
    exported = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
    assert.equal(exported.app, 'tweet-recovery');
    assert.equal(exported.tweets.length, Object.keys(await readDb(page)).length);
  });

  await check('1 件削除できる', async () => {
    const target = TIMELINE_A[0].id;
    const item = items(page).filter({ hasText: 'おはようございます' });
    await item.getByRole('button', { name: '削除' }).click();
    await wait(300);
    assert.equal((await readDb(page))[target], undefined);
    assert.equal(await item.count(), 0);
  });

  await check('全部削除 → インポートで元に戻せる', async () => {
    await page.getByRole('button', { name: '全部削除' }).click();
    await page.locator('#tweet-recovery-root .empty').waitFor();
    // 画面に出ているツイートは消した直後にまた記録されるので、更新前のものが消えたことだけ確かめる
    assert.equal((await readDb(page))[GOOD_ID], undefined);
    const file = path.join(os.tmpdir(), `tweet-recovery-import-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(exported));
    await page.locator('#tweet-recovery-root input[type="file"]').setInputFiles(file);
    await page.locator('#tweet-recovery-root .status', { hasText: '件を読み込みました' }).waitFor();
    const after = await readDb(page);
    assert.equal(after[GOOD_ID].starred, 1);
    assert.equal(after[GOOD_ID].text, db[GOOD_ID].text);
  });

  await check('インポートした不正なデータは無害化される', async () => {
    const file = path.join(os.tmpdir(), `tweet-recovery-bad-${Date.now()}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify([
        { id: '1790000000000000999', handle: 'x"/><script>', text: '<img src=x onerror=alert(1)>', avatar: 'javascript:alert(1)', lastSeenAt: Date.now() + 60000 },
        { id: 'not-a-number', text: 'ignored' },
      ]),
    );
    await page.locator('#tweet-recovery-root input[type="file"]').setInputFiles(file);
    await page.locator('#tweet-recovery-root .status', { hasText: '1件を読み込みました' }).waitFor();
    const first = items(page).first();
    assert.equal(await first.locator('a.link').getAttribute('href'), 'https://x.com/i/web/status/1790000000000000999');
    assert.equal(await first.locator('.text').innerText(), '<img src=x onerror=alert(1)>');
    assert.equal(await first.locator('img.avatar').count(), 0);
    await first.getByRole('button', { name: '削除' }).click();
  });

  await check('保存期間を過ぎたものは消える (★付きは残る)', async () => {
    const old = Date.now() - 40 * 24 * 3600 * 1000;
    const file = path.join(os.tmpdir(), `tweet-recovery-old-${Date.now()}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify([
        { id: '1000000000000000001', handle: 'old_one', text: '古いツイート', lastSeenAt: old },
        { id: '1000000000000000002', handle: 'old_star', text: '古いけど★', lastSeenAt: old, starred: 1 },
      ]),
    );
    await page.locator('#tweet-recovery-root input[type="file"]').setInputFiles(file);
    await page.locator('#tweet-recovery-root .status', { hasText: '2件を読み込みました' }).waitFor();
    await page.locator('#tweet-recovery-root select[aria-label="保存期間"]').selectOption('7');
    await wait(300);
    const after = await readDb(page);
    assert.equal(after['1000000000000000001'], undefined);
    assert.ok(after['1000000000000000002']);
    assert.ok(after[GOOD_ID], '最近のものは消えない');
  });

  await check('一時停止中は記録しない', async () => {
    await page.locator('#tweet-recovery-root .check', { hasText: '記録を一時停止' }).click();
    await page.keyboard.press('Escape');
    await page.locator('#tweet-recovery-root .panel').waitFor({ state: 'hidden' });
    assert.ok(await page.locator('#tweet-recovery-root .fab.paused').isVisible());
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const lastB = TIMELINE_B.at(-1).id;
    assert.equal((await settle(page))[lastB], undefined);

    await page.locator('#tweet-recovery-root .fab').click();
    await page.locator('#tweet-recovery-root .check', { hasText: '記録を一時停止' }).click();
    await page.locator('#tweet-recovery-root .panel .icon-btn[title^="閉じる"]').click();
    assert.ok((await settle(page))[lastB], '再開したら今見えているものは記録される');
  });

  await check('ボタンはドラッグで動かせて、位置を覚える', async () => {
    const fab = page.locator('#tweet-recovery-root .fab');
    const box = await fab.boundingBox();
    await page.mouse.move(box.x + 22, box.y + 22);
    await page.mouse.down();
    await page.mouse.move(box.x + 222, box.y - 178, { steps: 8 });
    await page.mouse.up();
    assert.ok(await page.locator('#tweet-recovery-root .panel').isHidden(), 'ドラッグでパネルが開いてしまった');
    await openX(page);
    const moved = await page.locator('#tweet-recovery-root .fab').boundingBox();
    assert.ok(Math.abs(moved.x - (box.x + 200)) <= 2 && Math.abs(moved.y - (box.y - 200)) <= 2, JSON.stringify({ box, moved }));
  });

  await check('ページ上で JavaScript のエラーが出ていない', async () => {
    assert.deepEqual(errors.map(String), []);
  });

  await context.close();
  return exported;
}

async function mobileSuite(browser, exported) {
  const state = { tweets: TIMELINE_B, dark: true };
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: 'ja-JP',
  });
  await serveX(context, state);
  const page = await context.newPage();
  await openX(page);

  await check('スマホ + ダークテーマでも開ける (タップ)', async () => {
    const file = path.join(os.tmpdir(), `tweet-recovery-mobile-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(exported));
    await page.locator('#tweet-recovery-root .fab').tap();
    await page.locator('#tweet-recovery-root .panel.dark').waitFor({ state: 'visible' });
    const box = await page.locator('#tweet-recovery-root .panel').boundingBox();
    assert.equal(Math.round(box.width), 390);
    await page.locator('#tweet-recovery-root summary').tap();
    await page.locator('#tweet-recovery-root input[type="file"]').setInputFiles(file);
    await page.locator('#tweet-recovery-root .status', { hasText: '件を読み込みました' }).waitFor();
    await page.locator('#tweet-recovery-root summary').tap();
    await page.locator('#tweet-recovery-root select[aria-label="並び順"]').selectOption('dwell');
    await wait(400);
    await page.screenshot({ path: path.join(OUT, 'panel-mobile-dark.png') });
  });

  await check('背景が透明でも theme-color からテーマ (ダークブルー) を判定する', async () => {
    await page.locator('#tweet-recovery-root .panel .icon-btn[title^="閉じる"]').tap();
    await page.evaluate(() => {
      document.body.style.background = 'transparent';
      document.head.append(Object.assign(document.createElement('meta'), { name: 'theme-color', content: '#15202b' }));
    });
    await page.locator('#tweet-recovery-root .fab').tap();
    const panel = page.locator('#tweet-recovery-root .panel.dark');
    await panel.waitFor({ state: 'visible' });
    assert.equal(await panel.evaluate((el) => el.style.getPropertyValue('--bg')), 'rgb(21, 32, 43)');
  });

  await context.close();
}

async function extensionSuite() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tweet-recovery-ext-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
  });
  const state = { tweets: TIMELINE_A };
  await serveX(context, state);
  const page = await context.newPage();

  await check('Chrome 拡張機能として読み込むと x.com で動く', async () => {
    await openX(page, { inject: false });
    const db = await settle(page);
    assert.ok(db[TIMELINE_A[0].id], '拡張機能から記録されていない');
    await page.keyboard.press('Alt+Shift+H');
    await page.locator('#tweet-recovery-root .item').first().waitFor();
  });

  await context.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  try {
    const exported = await userscriptSuite(browser);
    await mobileSuite(browser, exported);
  } finally {
    await browser.close();
  }
  await extensionSuite();
  console.log(`\nすべて成功 (${step} 項目)。スクリーンショット: ${path.relative(process.cwd(), OUT)}/`);
})().catch((err) => {
  console.log('NG');
  console.error(err);
  process.exit(1);
});
