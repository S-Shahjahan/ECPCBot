import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import CFB from 'cfb';
import path from 'node:path';

export async function officeText(buffer, ext) {
  if (['.xls', '.xlsx'].includes(ext)) {
    const book = XLSX.read(buffer, {
      type: 'buffer',
      cellText: true,
      cellFormula: false,
    });
    return book.SheetNames.map((name) => {
      const rows = XLSX.utils.sheet_to_json(book.Sheets[name], {
        header: 1,
        raw: false,
        defval: '',
      });
      const headings = rows.shift() || [];
      return (
        `Sheet: ${name}\n${headings.join(' | ')}\n` +
        rows
          .map((row) =>
            row
              .map((value, i) =>
                value === ''
                  ? ''
                  : `${headings[i] || 'Column ' + (i + 1)}: ${value}`,
              )
              .filter(Boolean)
              .join('; '),
          )
          .join('\n')
      );
    }).join('\n\n');
  }
  if (ext === '.pptx') {
    const zip = await JSZip.loadAsync(buffer);
    const parser = new XMLParser({
      ignoreAttributes: false,
      processEntities: true,
      preserveOrder: true,
    });
    const runs = (nodes) =>
      nodes
        .map((node) => {
          if (node['#text'] !== undefined) return String(node['#text']);
          return Object.entries(node)
            .filter(([key]) => key !== ':@')
            .map(([key, value]) =>
              Array.isArray(value)
                ? runs(value) + (key === 'a:p' ? '\n' : '')
                : '',
            )
            .join('');
        })
        .join('');
    let files = Object.keys(zip.files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort(
        (a, b) =>
          Number(a.match(/slide(\d+)/)[1]) - Number(b.match(/slide(\d+)/)[1]),
      );
    const presentation = zip.file('ppt/presentation.xml'),
      relationships = zip.file('ppt/_rels/presentation.xml.rels');
    if (presentation && relationships) {
      const meta = new XMLParser({
        ignoreAttributes: false,
        processEntities: false,
      });
      const array = (value) =>
        Array.isArray(value) ? value : value ? [value] : [];
      const order = array(
        meta.parse(await presentation.async('string'))['p:presentation']?.[
          'p:sldIdLst'
        ]?.['p:sldId'],
      );
      const rels = array(
        meta.parse(await relationships.async('string')).Relationships
          ?.Relationship,
      );
      const ordered = order
        .map((slide) =>
          rels.find(
            (rel) =>
              rel['@_Id'] === slide['@_r:id'] &&
              rel['@_TargetMode'] !== 'External',
          ),
        )
        .filter(Boolean)
        .map((rel) => path.posix.normalize('ppt/' + rel['@_Target']))
        .filter((file) => files.includes(file));
      if (ordered.length) files = ordered;
    }
    const slides = [];
    for (const [i, file] of files.entries()) {
      const xml = await zip.file(file).async('string');
      if (xml.length > 5000000)
        throw new Error('Split this presentation into smaller files.');
      if (/<!DOCTYPE|<!ENTITY/i.test(xml))
        throw new Error('Use a presentation without custom XML entities.');
      slides.push(`Slide ${i + 1}\n${runs(parser.parse(xml))}`);
    }
    return slides.join('\n\n');
  }
  const compound = CFB.read(buffer, { type: 'buffer' });
  const stream = compound.FileIndex.find(
    (f) => f.name === 'PowerPoint Document',
  )?.content;
  if (!stream) throw new Error('Use an unencrypted PPT or PPTX presentation.');
  const data = Buffer.from(stream),
    text = [];
  function scan(start, end, depth = 0) {
    if (depth > 64)
      throw new Error('Split this presentation into smaller files.');
    for (let at = start; at + 8 <= end;) {
      const flags = data.readUInt16LE(at),
        type = data.readUInt16LE(at + 2),
        size = data.readUInt32LE(at + 4),
        next = at + 8 + size;
      if (next > end || next <= at) break;
      if ((flags & 15) === 15) scan(at + 8, next, depth + 1);
      else if (type === 4000)
        text.push(data.subarray(at + 8, next).toString('utf16le'));
      else if (type === 4008)
        text.push(data.subarray(at + 8, next).toString('latin1'));
      at = next;
    }
  }
  scan(0, data.length);
  return text.join('\n');
}
