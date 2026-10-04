require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const pdfParse = require('pdf-parse');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 } // 15 MB
});

const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
if (!hasApiKey) {
  console.warn('NOTE: ANTHROPIC_API_KEY is not set. Digital PDF extraction (free) still works. ' +
    'Scanned photos/handwriting, and messy PDFs that the free parser can\'t read, will need it.');
}
const anthropic = hasApiKey ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Model used only as a fallback (messy PDFs) or for images/handwriting.
const EXTRACTION_MODEL = 'claude-sonnet-5-5';

const EXTRACTION_PROMPT = `You are extracting structured data from a business document — a Purchase Order, Quotation, Proforma Invoice, or Tax Invoice. It may be a clean PDF's text, a scanned photo, or a handwritten note.

Read it carefully and return ONLY a single valid JSON object (no markdown fences, no commentary) with exactly this shape:

{
  "docType": "po" | "quotation" | "proforma" | "invoice",
  "seller": { "sellerName":"", "sellerAddress":"", "sellerState":"", "sellerGSTIN":"", "sellerPhone":"", "sellerEmail":"", "sellerJurisdiction":"" },
  "buyer": { "buyerName":"", "buyerBilling":"", "sameAsBilling":true, "buyerShipping":"", "buyerState":"", "buyerGSTIN":"" },
  "docMeta": { "docNumber":"", "docDate":"YYYY-MM-DD", "date2":"YYYY-MM-DD", "refNumber":"", "paymentTerms":"", "placeOfSupply":"" },
  "items": [ { "description":"", "hsn":"", "unit":"Nos", "qty":0, "rate":0, "discount":0, "tax":18 } ],
  "otherCharge": { "desc":"", "amount":0, "tax":18 },
  "bank": { "name":"", "branch":"", "accNo":"", "ifsc":"", "accName":"" },
  "terms": "",
  "signatoryName": "",
  "roundOff": true
}

Rules:
- If a field isn't present, use "" (or 0 / empty array). Never invent values.
- docType from the title: Purchase Order->"po", Quotation/Quote->"quotation", Proforma Invoice->"proforma", Tax Invoice/Invoice->"invoice". Default "invoice" if unclear.
- Dates normalised to YYYY-MM-DD.
- "tax" is the TOTAL GST % (18 for 9%+9%, or 18% IGST) — not half.
- For handwriting/unclear scans, make the single most reasonable reading rather than leaving blank.
- Output raw JSON only, no markdown fences, no text before or after it.`;

/**
 * FREE PATH — no API key, no cost.
 * Works on the embedded text of a normal digital PDF (e.g. Tally / accounting-software exports).
 * Tuned for the common Indian GST document layout. Best-effort regex parser: reliable for clearly
 * labelled fields (GSTIN, State, Invoice No., bank details), weaker on item-table rows if a
 * document uses an unusual layout — that's exactly the case where the AI fallback kicks in.
 */
function parseDocumentText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const data = {
    docType: 'invoice',
    seller: { sellerName:'', sellerAddress:'', sellerState:'', sellerGSTIN:'', sellerPhone:'', sellerEmail:'', sellerJurisdiction:'' },
    buyer: { buyerName:'', buyerBilling:'', sameAsBilling:true, buyerShipping:'', buyerState:'', buyerGSTIN:'' },
    docMeta: { docNumber:'', docDate:'', date2:'', refNumber:'', paymentTerms:'', placeOfSupply:'' },
    items: [],
    otherCharge: { desc:'', amount:0, tax:18 },
    bank: { name:'', branch:'', accNo:'', ifsc:'', accName:'' },
    terms: '',
    signatoryName: '',
    roundOff: true
  };

  if (/PROFORMA INVOICE/i.test(text)) data.docType = 'proforma';
  else if (/TAX INVOICE/i.test(text)) data.docType = 'invoice';
  else if (/QUOTATION/i.test(text)) data.docType = 'quotation';
  else if (/PURCHASE ORDER/i.test(text)) data.docType = 'po';

  const titleIdx = lines.findIndex(l => /PROFORMA INVOICE|TAX INVOICE|QUOTATION|PURCHASE ORDER/i.test(l));
  const firstGSTIdx = lines.findIndex(l => /GSTIN\s*\/\s*UIN/i.test(l));
  if (titleIdx >= 0 && firstGSTIdx > titleIdx) {
    data.seller.sellerName = lines[titleIdx + 1] || '';
    data.seller.sellerAddress = lines.slice(titleIdx + 2, firstGSTIdx).join(', ');
  }

  const gstMatches = [...text.matchAll(/GSTIN\s*\/\s*UIN\s*:?\s*([0-9A-Z]{15})/gi)];
  if (gstMatches[0]) data.seller.sellerGSTIN = gstMatches[0][1];
  if (gstMatches[1]) data.buyer.buyerGSTIN = gstMatches[1][1];

  const stateMatches = [...text.matchAll(/State Name\s*:\s*([A-Za-z ]+?),\s*Code\s*:\s*\d+/gi)];
  if (stateMatches[0]) data.seller.sellerState = stateMatches[0][1].trim();
  if (stateMatches[1]) data.buyer.buyerState = stateMatches[1][1].trim();

  const docNoMatch = text.match(/Invoice No\.?\s*\n?\s*([^\n]+)/i);
  if (docNoMatch) data.docMeta.docNumber = docNoMatch[1].trim();

  const dateMatch = text.match(/Dated\s*\n?\s*(\d{1,2}[-\/][A-Za-z]{3}[-\/]\d{2,4})/i);
  if (dateMatch) data.docMeta.docDate = normalizeDate(dateMatch[1]);

  const buyerIdx = lines.findIndex(l => /Buyer\s*\(Bill\s*to\)/i.test(l));
  if (buyerIdx >= 0) {
    data.buyer.buyerName = lines[buyerIdx + 1] || '';
    const addrLines = [];
    for (let i = buyerIdx + 2; i < lines.length; i++) {
      if (/GSTIN\s*\/\s*UIN/i.test(lines[i])) break;
      addrLines.push(lines[i]);
    }
    data.buyer.buyerBilling = addrLines.join(', ');
  }

  const consigneeIdx = lines.findIndex(l => /Consignee\s*\(Ship\s*to\)/i.test(l));
  if (consigneeIdx >= 0 && buyerIdx >= 0) {
    const consigneeBlock = lines.slice(consigneeIdx + 1, buyerIdx).join(', ');
    const buyerBlock = data.buyer.buyerBilling;
    data.buyer.sameAsBilling = consigneeBlock.replace(/\s+/g,'') === buyerBlock.replace(/\s+/g,'');
    if (!data.buyer.sameAsBilling) data.buyer.buyerShipping = consigneeBlock;
  }

  const bankNameMatch = text.match(/Bank Name\s*:\s*([^\n]+)/i);
  if (bankNameMatch) data.bank.name = bankNameMatch[1].trim();
  const accNoMatch = text.match(/A\/c No\.?\s*:\s*([^\n]+)/i);
  if (accNoMatch) data.bank.accNo = accNoMatch[1].trim();
  const branchIfscMatch = text.match(/Branch\s*&?\s*IFS Code:?\s*([^\n&]+)&\s*([A-Z]{4}0[0-9A-Z]{6})/i);
  if (branchIfscMatch) { data.bank.branch = branchIfscMatch[1].trim(); data.bank.ifsc = branchIfscMatch[2].trim(); }

  const itemLineRe = /^(\d+)\s+(.+?)\s+(\d{4,8})\s+([\d,]+\.\d{2,4})\s+(\S+)\s+([\d,]+\.\d{2})\s+\S+\s+([\d,]+\.\d{2})$/;
  lines.forEach(l => {
    const m = l.match(itemLineRe);
    if (m) {
      data.items.push({
        description: m[2].trim(),
        hsn: m[3],
        unit: m[5],
        qty: parseFloat(m[4].replace(/,/g, '')),
        rate: parseFloat(m[6].replace(/,/g, '')),
        discount: 0,
        tax: 18
      });
    }
  });

  const transportMatch = text.match(/Transportation Charges\s+([\d,]+\.\d{2})/i);
  if (transportMatch) {
    data.otherCharge.desc = 'Transportation Charges';
    data.otherCharge.amount = parseFloat(transportMatch[1].replace(/,/g, ''));
    data.otherCharge.tax = 18;
  }

  const declarationMatch = text.match(/We declare[^\n]*(?:\n[^\n]*)*?correct\.?/i);
  if (declarationMatch) data.terms = declarationMatch[0].replace(/\s+/g, ' ').trim();

  return data;
}

function normalizeDate(d) {
  const months = { Jan:'01', Feb:'02', Mar:'03', Apr:'04', May:'05', Jun:'06', Jul:'07', Aug:'08', Sep:'09', Oct:'10', Nov:'11', Dec:'12' };
  const m = d.match(/(\d{1,2})[-\/]([A-Za-z]{3})[-\/](\d{2,4})/);
  if (!m) return '';
  const yr = m[3].length === 2 ? '20' + m[3] : m[3];
  const mo = months[m[2].charAt(0).toUpperCase() + m[2].slice(1, 3).toLowerCase()] || '01';
  return `${yr}-${mo}-${m[1].padStart(2, '0')}`;
}

function freeResultLooksUsable(data) {
  return !!(data.seller.sellerName && data.buyer.buyerName && data.items.length > 0);
}

async function extractWithAI({ mode, text, mimeType, base64 }) {
  if (!anthropic) throw new Error('This document needs AI reading, but ANTHROPIC_API_KEY is not set on the server.');
  const contentBlock = mode === 'image'
    ? { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } }
    : { type: 'text', text: 'DOCUMENT TEXT (extracted from PDF):\n\n' + text };

  const response = await anthropic.messages.create({
    model: EXTRACTION_MODEL,
    max_tokens: 2000,
    messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: EXTRACTION_PROMPT }] }]
  });

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('The model did not return any data.');
  const cleaned = textBlock.text.trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
  return JSON.parse(cleaned);
}

app.post('/api/extract', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const mimeType = req.file.mimetype;

    if (mimeType === 'application/pdf') {
      const pdfData = await pdfParse(req.file.buffer);
      const text = pdfData.text || '';
      const freeResult = parseDocumentText(text);

      if (freeResultLooksUsable(freeResult)) {
        return res.json({ data: freeResult, method: 'free-text-parse' });
      }
      if (!anthropic) {
        return res.json({ data: freeResult, method: 'free-text-parse-partial',
          warning: 'This PDF\'s layout is unusual — some fields may be missing. Set ANTHROPIC_API_KEY for a more reliable fallback on documents like this.' });
      }
      const aiResult = await extractWithAI({ mode: 'text', text });
      return res.json({ data: aiResult, method: 'ai-text-fallback' });
    }

    if (mimeType.startsWith('image/')) {
      if (!anthropic) {
        return res.status(400).json({ error: 'Scanned photos and handwriting have no embedded text, so they need AI reading — set ANTHROPIC_API_KEY to enable this. Plain digital PDFs work without it.' });
      }
      const base64 = req.file.buffer.toString('base64');
      const aiResult = await extractWithAI({ mode: 'image', mimeType, base64 });
      return res.json({ data: aiResult, method: 'ai-vision' });
    }

    return res.status(400).json({ error: 'Unsupported file type. Please upload a PDF or an image (JPG/PNG).' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Extraction failed. Please try again.' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true, aiConfigured: hasApiKey }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Document generator running on port ${PORT} (AI fallback ${hasApiKey ? 'enabled' : 'disabled — set ANTHROPIC_API_KEY to enable'})`);
});
