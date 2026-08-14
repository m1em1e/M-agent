import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const sizes = [16, 32, 48, 64, 128, 256];
const images = await Promise.all(sizes.map(async (size) => {
  const path = resolve(projectRoot, "build", "icons", `${size}x${size}.png`);
  const data = await readFile(path);
  assertPng(data, size, path);
  return { size, data };
}));

const headerSize = 6;
const entrySize = 16;
let imageOffset = headerSize + entrySize * images.length;
const directory = Buffer.alloc(imageOffset);
directory.writeUInt16LE(0, 0);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(images.length, 4);

for (const [index, image] of images.entries()) {
  const offset = headerSize + index * entrySize;
  directory.writeUInt8(image.size === 256 ? 0 : image.size, offset);
  directory.writeUInt8(image.size === 256 ? 0 : image.size, offset + 1);
  directory.writeUInt8(0, offset + 2);
  directory.writeUInt8(0, offset + 3);
  directory.writeUInt16LE(1, offset + 4);
  directory.writeUInt16LE(32, offset + 6);
  directory.writeUInt32LE(image.data.length, offset + 8);
  directory.writeUInt32LE(imageOffset, offset + 12);
  imageOffset += image.data.length;
}

const outputPath = resolve(projectRoot, "build", "icon.ico");
await writeFile(outputPath, Buffer.concat([directory, ...images.map((image) => image.data)]));
console.log(`Generated ${outputPath} with ${images.length} PNG frames (${sizes.join(", ")}px).`);

function assertPng(data, expectedSize, path) {
  const signature = "89504e470d0a1a0a";
  if (data.length < 24 || data.subarray(0, 8).toString("hex") !== signature) {
    throw new Error(`${path} is not a valid PNG file.`);
  }
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  if (width !== expectedSize || height !== expectedSize) {
    throw new Error(`${path} must be ${expectedSize}x${expectedSize}, got ${width}x${height}.`);
  }
}
