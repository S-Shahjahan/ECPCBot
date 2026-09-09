import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import WordExtractor from 'word-extractor';
import { createWorker } from 'tesseract.js';
import { createRequire } from 'node:module';
import path from 'node:path';
import sharp from 'sharp';
const require = createRequire(import.meta.url);
async function ocr(buffer) {
  // Decode only supported raster images, with a hard pixel limit before OCR allocation.
  const source = sharp(buffer, { limitInputPixels: 20000000 });
  const metadata = await source.metadata();
  if (!['png', 'jpeg', 'webp'].includes(metadata.format))
    throw new Error('Use PNG, JPEG or WebP for images.');
  buffer = await source
    .resize({
      width: 2200,
      height: 2200,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();
  const langPath = require('@tesseract.js-data/eng').langPath;
  const worker = await createWorker('eng', 1, {
    langPath,
    cacheMethod: 'none',
    logger: () => {},
  });
  try {
    return (await worker.recognize(buffer)).data.text;
  } finally {
    await worker.terminate();
  }
}
process.once('message', async ({ base64, name }) => {
  try {
    const buffer = Buffer.from(base64, 'base64');
    const ext = path.extname(name).toLowerCase();
    let text = '',
      note = '';
    if (['.txt', '.md', '.csv'].includes(ext)) {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      if (text.includes('\0'))
        throw new Error('Text files must be UTF-8, not binary.');
    } else if (ext === '.docx')
      text = (await mammoth.extractRawText({ buffer })).value;
    else if (ext === '.doc')
      text = (await new WordExtractor().extract(buffer)).getBody();
    else if (ext === '.pdf') {
      if (buffer.subarray(0, 5).toString() !== '%PDF-')
        throw new Error('The file is not a valid PDF.');
      const parser = new PDFParse({ data: buffer, isEvalSupported: false });
      try {
        const info = await parser.getInfo();
        if (info.total > 80)
          throw new Error('Split this PDF into files of 80 pages or fewer.');
        const result = await parser.getText();
        const pages = [];
        for (const page of result.pages) {
          if (page.text.trim().length > 40) pages.push(page.text);
          else {
            if (info.total > 10)
              throw new Error(
                'Scanned PDFs are limited to 10 pages. Split the file and retry.',
              );
            const screenshot = await parser.getScreenshot({
              partial: [page.num],
              desiredWidth: 1600,
              imageDataUrl: false,
            });
            pages.push(await ocr(screenshot.pages[0].data));
            note =
              'OCR was used. Check names, prices and dates carefully. OCR currently supports English.';
          }
        }
        text = pages.join('\n\n');
      } finally {
        await parser.destroy();
      }
    } else if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
      text = await ocr(buffer);
      note =
        'English OCR extracted visible text, not visual meaning. Check all extracted facts before approval.';
    } else
      throw new Error(
        'Use PDF, DOCX, DOC, TXT, Markdown, CSV, PNG, JPEG or WebP.',
      );
    text = text.replace(/\0/g, '').trim();
    if (!text)
      throw new Error(
        'No readable text was found. Try a clearer image or enter the facts directly.',
      );
    if (text.length > 100000)
      throw new Error(
        'This file contains too much text. Split it into smaller files (100,000 characters each).',
      );
    process.send({ text, note });
  } catch (error) {
    process.send({
      error: /Split |Use |No readable|too much|Text files|not a valid/.test(
        error.message,
      )
        ? error.message
        : 'Could not read this file. Check that it is supported, unencrypted and undamaged.',
    });
  } finally {
    process.disconnect();
  }
});
