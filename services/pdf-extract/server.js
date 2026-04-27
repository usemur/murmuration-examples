import express from 'express';
import { convert } from '@opendataloader/pdf';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const app = express();
app.use(express.json({ limit: '20mb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/extract', async (req, res) => {
  const { pdf_base64 } = req.body;
  if (!pdf_base64) {
    return res.status(400).json({ error: 'Missing pdf_base64 field' });
  }

  let tmpDir;
  try {
    // Write PDF to temp file
    tmpDir = await mkdtemp(join(tmpdir(), 'pdf-extract-'));
    const inputPath = join(tmpDir, 'input.pdf');
    const outputDir = join(tmpDir, 'output');
    await writeFile(inputPath, Buffer.from(pdf_base64, 'base64'));

    // Run opendataloader-pdf
    await convert([inputPath], {
      outputDir,
      format: 'markdown',
    });

    // Read the markdown output
    const outputPath = join(outputDir, 'input.md');
    const markdown = await readFile(outputPath, 'utf-8');

    res.json({ text: markdown });
  } catch (err) {
    console.error('Extraction failed:', err);
    res.status(500).json({ error: 'PDF extraction failed', detail: err.message });
  } finally {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`pdf-extract listening on :${port}`);
});
