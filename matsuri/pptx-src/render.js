const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const dir = process.argv[2];
const emojis = {yakisoba:'🥢',udon:'🍜',onigiri:'🍙',frank:'🌭',wata:'🍭',drink:'🥤',beer:'🍺',bingo:'🎱',shateki:'🎯',golf:'⛳',shami:'🪇',odori:'💃',party:'🎉'};
const lantern = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 160" width="400" height="640">
  <line x1="50" y1="0" x2="50" y2="18" stroke="#4a2c1a" stroke-width="3"/>
  <rect x="28" y="16" width="44" height="12" rx="3" fill="#4a2c1a"/>
  <ellipse cx="50" cy="80" rx="42" ry="54" fill="#e8483b"/>
  <g stroke="#b8302a" stroke-width="2.5" fill="none"><ellipse cx="50" cy="80" rx="42" ry="40"/><ellipse cx="50" cy="80" rx="42" ry="22"/><line x1="8" y1="80" x2="92" y2="80"/></g>
  <text x="50" y="95" font-size="40" text-anchor="middle" fill="#fff" font-family="Mochiy Pop One">祭</text>
  <rect x="28" y="130" width="44" height="12" rx="3" fill="#4a2c1a"/>
  <g stroke="#f6c343" stroke-width="3"><line x1="40" y1="142" x2="40" y2="158"/><line x1="50" y1="142" x2="50" y2="160"/><line x1="60" y1="142" x2="60" y2="158"/></g></svg>`;
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage();
  for (const [k, e] of Object.entries(emojis)) {
    await p.setContent(`<html><body style="margin:0;background:transparent"><div id=e style="font:400 200px 'Noto Color Emoji';width:256px;height:256px;display:grid;place-items:center;line-height:1">${e}</div></body></html>`);
    await p.locator('#e').screenshot({ path: `${dir}/${k}.png`, omitBackground: true });
  }
  await p.setContent(`<html><head><link href="https://fonts.googleapis.com/css2?family=Mochiy+Pop+One&display=block" rel="stylesheet"></head><body style="margin:0;background:transparent"><div id=e style="width:400px;height:640px">${lantern}</div></body></html>`);
  await p.waitForTimeout(2500);
  await p.locator('#e').screenshot({ path: `${dir}/lantern.png`, omitBackground: true });
  await b.close();
})();
