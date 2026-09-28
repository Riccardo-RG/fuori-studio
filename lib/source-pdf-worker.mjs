import { parentPort, workerData } from 'node:worker_threads';

// Parsing is isolated in a disposable worker so malformed PDFs cannot hold the
// server event loop indefinitely. No rendering, document actions or URL loading.
try {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(workerData.data), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, useWorkerFetch: false, stopAtErrors: true, verbosity: 0 });
  const document = await task.promise;
  try {
    if (document.numPages > workerData.maxPages) throw Error('PDF_TOO_MANY_PAGES');
    const pages = []; let chars = 0;
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      const text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim();
      chars += text.length;
      if (chars > workerData.maxChars) throw Error('PDF_TOO_MUCH_TEXT');
      pages.push({ page: number, text });
      page.cleanup();
    }
    parentPort.postMessage({ pages });
  } finally { await document.destroy(); }
} catch (error) { parentPort.postMessage({ error: error?.message === 'PDF_TOO_MANY_PAGES' || error?.message === 'PDF_TOO_MUCH_TEXT' ? error.message : 'PDF_EXTRACTION_FAILED' }); }
