const pptxgen = require('pptxgenjs');
const path = require('path');
const IMG = process.argv[2], OUT = process.argv[3];
const pres = new pptxgen();
pres.defineLayout({ name: 'A3P', width: 297 / 25.4, height: 420 / 25.4 });
pres.layout = 'A3P';
pres.title = '御幸一自治会まつり 2026 価格表';
pres.theme = { headFontFace: 'HGS創英角ﾎﾟｯﾌﾟ体', bodyFontFace: 'HG丸ｺﾞｼｯｸM-PRO' };
const POP = 'HGS創英角ﾎﾟｯﾌﾟ体', MARU = 'HG丸ｺﾞｼｯｸM-PRO';
const m = v => v / 25.4;
const img = n => path.join(IMG, n + '.png');
const RED = 'E8483B', BROWN = '4A2C1A', ORANGE = 'F6A623', GREEN = '3FAE6A';
const s = pres.addSlide();
s.background = { path: img('bg') };

// frame
s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: m(9), y: m(9), w: m(279), h: m(402), rectRadius: m(12), fill: { type: 'none' }, line: { color: RED, width: 8.5 }, objectName: 'Frame outer' });
s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: m(14), y: m(14), w: m(269), h: m(392), rectRadius: m(8), fill: { type: 'none' }, line: { color: ORANGE, width: 2.5 }, objectName: 'Frame inner' });

// bunting rope + flags
const x0 = 20, x1 = 277, top = 12, sag = 15;
const yAt = x => top + 4 * sag * ((x - x0) / (x1 - x0)) * (1 - (x - x0) / (x1 - x0));
const pts = [];
for (let i = 0; i <= 20; i++) { const x = x0 + (x1 - x0) * i / 20; pts.push({ x: m(x - x0), y: m(yAt(x) - top) }); }
s.addShape(pres.shapes.CUSTOM_GEOMETRY, { x: m(x0), y: m(top), w: m(x1 - x0), h: m(sag), points: pts, line: { color: BROWN, width: 1.5 }, fill: { type: 'none' }, objectName: 'Bunting rope' });
const cols = [RED, 'F6C343', GREEN, '3B8FD9', 'F08A24', 'E46AA6'];
for (let i = 0; i < 15; i++) {
  const cx = x0 + 10 + i * ((x1 - x0 - 20) / 14);
  if (cx < 52 || cx > 245) continue; // keep clear of the lanterns
  s.addShape(pres.shapes.ISOSCELES_TRIANGLE, { x: m(cx - 6.5), y: m(yAt(cx) - 0.5), w: m(13), h: m(13), flipV: true, fill: { color: cols[i % 6] }, line: { type: 'none' }, objectName: 'Flag ' + (i + 1) });
}
s.addImage({ path: img('lantern'), x: m(22), y: m(14), w: m(26), h: m(41.6), objectName: 'Lantern left' });
s.addImage({ path: img('lantern'), x: m(249), y: m(14), w: m(26), h: m(41.6), objectName: 'Lantern right' });

// header
s.addText('模擬店 メニュー', { x: m(93.5), y: m(38), w: m(110), h: m(15), fill: { color: RED }, shape: pres.shapes.ROUNDED_RECTANGLE, rectRadius: m(7.5), color: 'FFFFFF', fontFace: MARU, fontSize: 28, bold: true, align: 'center', valign: 'middle', charSpacing: 3, margin: 0, objectName: 'Subtitle pill' });
s.addText('御幸一自治会まつり', { x: m(20), y: m(56), w: m(257), h: m(30), color: RED, fontFace: POP, fontSize: 64, align: 'center', valign: 'middle', margin: 0, isTextBox: true, fit: 'shrink',
  shadow: { type: 'outer', color: 'F6C343', blur: 0, offset: 4, angle: 45, opacity: 1 }, objectName: 'Title' });
s.addText([{ text: '★  ', options: { color: ORANGE, fontSize: 24 } }, { text: '2026', options: { color: BROWN } }, { text: '  ★', options: { color: ORANGE, fontSize: 24 } }],
  { x: m(80), y: m(87), w: m(137), h: m(16), fontFace: POP, fontSize: 38, charSpacing: 6, align: 'center', valign: 'middle', margin: 0, isTextBox: true, objectName: 'Year' });

// menu cards
const card = (x, y, w, item) => {
  const h = 29;
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: m(x), y: m(y), w: m(w), h: m(h), rectRadius: m(7), fill: { color: 'FFFFFF' }, line: { color: BROWN, width: 3 },
    shadow: { type: 'outer', color: BROWN, blur: 0, offset: 4, angle: 45, opacity: 1 }, objectName: item.name + ' card' });
  s.addShape(pres.shapes.OVAL, { x: m(x + 4), y: m(y + 3.5), w: m(22), h: m(22), fill: { color: item.bg }, line: { type: 'none' }, objectName: item.name + ' icon bg' });
  s.addImage({ path: img(item.ic), x: m(x + 6.5), y: m(y + 6), w: m(17), h: m(17), objectName: item.name + ' icon' });
  s.addText([{ text: item.name, options: { fontSize: 21, bold: true, color: BROWN, breakLine: true } }, { text: item.sub, options: { fontSize: 12, color: 'A0715A' } }],
    { x: m(x + 29), y: m(y + 3), w: m(w - 29 - 40), h: m(h - 6), fontFace: MARU, valign: 'middle', margin: 0, isTextBox: true, fit: 'shrink', objectName: item.name + ' name' });
  s.addText([{ text: '¥', options: { fontSize: 22 } }, { text: item.price, options: { fontSize: 36 } }],
    { x: m(x + w - 42), y: m(y + 3), w: m(38), h: m(h - 6), fontFace: POP, color: RED, align: 'right', valign: 'middle', margin: 0, isTextBox: true, objectName: item.name + ' price' });
};
const items = [
  { name: '焼きそば', sub: '1パック', price: '200', ic: 'yakisoba', bg: 'FFE1C2' },
  { name: 'けんちんうどん', sub: '1杯', price: '200', ic: 'udon', bg: 'FFE9B0' },
  { name: 'おにぎり', sub: '2個入り', price: '300', ic: 'onigiri', bg: 'E3F2DD' },
  { name: 'フランクフルト', sub: '1本', price: '100', ic: 'frank', bg: 'FFD6D0' },
  { name: 'わたあめ', sub: '1つ', price: '100', ic: 'wata', bg: 'FFE0F0' },
  { name: 'ソフトドリンク', sub: '1本', price: '100', ic: 'drink', bg: 'D9EEFC' },
];
const L = 22, CW = 123.5, GAP = 6;
items.forEach((it, i) => card(L + (i % 2) * (CW + GAP), 107 + Math.floor(i / 2) * 34, CW, it));
card(L, 209, CW * 2 + GAP, { name: '生ビール', sub: 'キンキンに冷えてます！', price: '300', ic: 'beer', bg: 'FFF0B3' });
s.addText('20歳以上の方のみ', { x: m(213), y: m(205.5), w: m(46), h: m(7), shape: pres.shapes.ROUNDED_RECTANGLE, rectRadius: m(2.5), fill: { color: '3B8FD9' }, color: 'FFFFFF', fontFace: MARU, fontSize: 12, bold: true, align: 'center', valign: 'middle', margin: 0, objectName: 'Age badge' });
s.addText('※ なくなり次第終了となります。お早めにどうぞ！', { x: m(22), y: m(242), w: m(253), h: m(8), fontFace: MARU, fontSize: 15, color: '8A5A3C', align: 'center', valign: 'middle', margin: 0, isTextBox: true, objectName: 'Note' });

// games box
s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: m(22), y: m(262), w: m(253), h: m(98), rectRadius: m(9), fill: { color: 'FFFFFF' }, line: { color: RED, width: 3, dashType: 'dash' }, objectName: 'Games box' });
s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: m(88.5), y: m(254), w: m(120), h: m(16), rectRadius: m(3.5), fill: { color: GREEN }, line: { type: 'none' },
  shadow: { type: 'outer', color: '2B7F4C', blur: 0, offset: 4, angle: 90, opacity: 1 }, objectName: 'Games title pill' });
s.addImage({ path: img('party'), x: m(93), y: m(256), w: m(12), h: m(12), objectName: 'Party left' });
s.addImage({ path: img('party'), x: m(192), y: m(256), w: m(12), h: m(12), objectName: 'Party right' });
s.addText('ゲーム・余興', { x: m(105), y: m(254), w: m(87), h: m(16), fontFace: POP, fontSize: 34, color: 'FFFFFF', align: 'center', valign: 'middle', margin: 0, isTextBox: true, objectName: 'Games title' });
const games = [['ビンゴゲーム', 'bingo'], ['射的', 'shateki'], ['ホールインワン', 'golf']];
const GW = 75, GX = 29;
games.forEach(([n, ic], i) => {
  const x = GX + i * (GW + 7);
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: m(x), y: m(276), w: m(GW), h: m(48), rectRadius: m(6), fill: { color: 'FFF3D6' }, line: { type: 'none' }, objectName: n + ' tile' });
  s.addImage({ path: img(ic), x: m(x + GW / 2 - 7), y: m(279), w: m(14), h: m(14), objectName: n + ' icon' });
  s.addText(n, { x: m(x + 2), y: m(294), w: m(GW - 4), h: m(11), fontFace: MARU, fontSize: 20, bold: true, color: BROWN, align: 'center', valign: 'middle', margin: 0, isTextBox: true, fit: 'shrink', objectName: n + ' name' });
  s.addText('参加無料', { x: m(x + GW / 2 - 16), y: m(307), w: m(32), h: m(9), shape: pres.shapes.ROUNDED_RECTANGLE, rectRadius: m(4.5), fill: { color: RED }, color: 'FFFFFF', fontFace: MARU, fontSize: 15, bold: true, align: 'center', valign: 'middle', margin: 0, objectName: n + ' free' });
});
const shows = [['スコップ三味線', '寿会のみなさん', 'shami'], ['民謡踊り', 'みんなで踊ろう！', 'odori']];
const YW = 116;
shows.forEach(([n, sub, ic], i) => {
  const x = GX + i * (YW + 7);
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: m(x), y: m(329), w: m(YW), h: m(24), rectRadius: m(6), fill: { color: 'E7F5EC' }, line: { type: 'none' }, objectName: n + ' tile' });
  s.addImage({ path: img(ic), x: m(x + 5), y: m(333), w: m(16), h: m(16), objectName: n + ' icon' });
  s.addText([{ text: n, options: { fontSize: 20, bold: true, color: BROWN, breakLine: true } }, { text: sub, options: { fontSize: 14, color: '2B7F4C' } }],
    { x: m(x + 25), y: m(331), w: m(YW - 29), h: m(20), fontFace: MARU, valign: 'middle', margin: 0, isTextBox: true, objectName: n + ' text' });
});
s.addText('みなさまのお越しをお待ちしています♪', { x: m(22), y: m(380), w: m(253), h: m(14), fontFace: MARU, fontSize: 24, bold: true, color: RED, align: 'center', valign: 'middle', margin: 0, isTextBox: true, objectName: 'Footer' });

pres.writeFile({ fileName: OUT }).then(() => console.log('wrote', OUT));
