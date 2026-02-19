const sharp = require('sharp');
const path  = require('path');

const assets = [
  { input: 'promo-small.svg',   output: 'promo-small.png',   width: 440,  height: 280 },
  { input: 'promo-marquee.svg', output: 'promo-marquee.png', width: 1400, height: 560 },
];

(async () => {
  for (const { input, output, width, height } of assets) {
    await sharp(path.join(__dirname, input))
      .resize(width, height)
      .png({ compressionLevel: 9 })
      .toFile(path.join(__dirname, output));
    console.log(`Generated ${output} (${width}x${height})`);
  }
})();
