// Renders an SVG file to a transparent WebP of the given width. Usage: node raster-svg.mjs <in.svg> <out.webp> <width>
import sharp from 'sharp';
const [i, o, w] = process.argv.slice(2);
const info = await sharp(i, { density: 300 }).resize({ width: +w }).webp({ quality: 90, alphaQuality: 100 }).toFile(o);
console.log(JSON.stringify(info));
