import { useState } from 'react';
import { Link } from 'react-router-dom';
import { API_BASE, api } from '../api';
import { ErrorBox, Id, useAction } from '../ui';

interface Report {
  suppliers: number; products: number; records: number; versions: number; documents: number; qrTokens: number;
  newAttributes: string[]; createdRecords: string[]; updatedRecords: string[]; unchangedRecords: string[];
  updatedProducts: string[]; skippedDocuments: string[];
}

const COLUMNS: [string, string, boolean][] = [
  ['supplier_name', 'Supplier legal name, as on its shipping label', true],
  ['part_number', 'Company item number ("Item" / "Part No")', true],
  ['part_description', 'As on the PO. Use quotes if it contains commas', true],
  ['purchase_order_number', '10-digit PO number', true],
  ['po_line_number', 'PO line, e.g. 4', true],
  ['quantity', 'Pieces shipped on this PO line', true],
  ['heat_numbers', 'Several? Separate with | (HT-1|HT-2)', true],
  ['pattern_number', 'Casting pattern / mould number', true],
  ['radiographic_test_number', 'RT report reference', false],
  ['material', 'e.g. ASTM A216 WCB', false],
  ['design_revision', 'e.g. E', false],
  ['country_of_origin', '2-letter code: IN, AE, DE...', false],
  ['supplier_country', '2-letter code', false],
];

export function ImportCsv() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<{ header: string[]; rows: number } | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [drag, setDrag] = useState(false);
  const { busy, error, run, setError } = useAction();

  const choose = async (f: File | undefined | null) => {
    if (!f) return;
    setReport(null); setError(null); setFile(f);
    const text = await f.text();
    const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
    setPreview({ header: (lines[0] ?? '').split(',').map((h) => h.trim()), rows: Math.max(0, lines.length - 1) });
  };
  const doImport = () => run(async () => {
    const form = new FormData();
    form.set('file', file!);
    setReport(await api<Report>('/import', { form }));
  });
  const template = async () => {
    const res = await fetch(`${API_BASE}/api/v1/import/template`);
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url; a.download = 'spir-import-template.csv'; a.click();
    URL.revokeObjectURL(url);
  };
  const missing = preview ? COLUMNS.filter(([c, , req]) => req && !preview.header.includes(c)).map(([c]) => c) : [];

  return (
    <>
      <div className="page-head">
        <h1>Import CSV</h1>
        <p className="lede">One row per shipment: one part against one PO line. SPIR creates a QR code for every new shipment.
          Importing an updated file later changes the data behind the same QR codes, so printed labels keep working.</p>
      </div>
      <div className="grid-2">
        <section className="panel stack">
          <div
            className={`dropzone${drag ? ' over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); choose(e.dataTransfer.files?.[0]); }}
          >
            <p style={{ margin: 0 }}><strong>Drop your CSV file here</strong> or</p>
            <label className="btn">Choose file<input type="file" accept=".csv,text/csv" hidden onChange={(e) => choose(e.target.files?.[0])} /></label>
            {file && <p className="small" style={{ margin: 0 }}>{file.name}: {preview?.rows ?? 0} rows</p>}
          </div>
          {missing.length > 0 && <div className="notice warn">This file has no column for: {missing.join(', ')}. Every row must have these, or nothing is imported.</div>}
          <div className="row">
            <button className="btn primary" onClick={doImport} disabled={!file || busy}>{busy ? 'Importing...' : 'Import and create QR codes'}</button>
            <button className="btn" onClick={template}>Download a template</button>
          </div>
          <ErrorBox error={error} />
          {report && (
            <div className="notice ok">
              <strong>Import finished.</strong>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                <li>{report.createdRecords.length} new shipment record{report.createdRecords.length === 1 ? '' : 's'}, {report.qrTokens} new QR code{report.qrTokens === 1 ? '' : 's'}</li>
                <li>{report.updatedRecords.length} updated (same QR code, new version){report.updatedRecords.length ? ': ' : ''}{report.updatedRecords.map((c) => <Link key={c} to={`/records/${c}`} style={{ marginRight: 6 }}><Id>{c}</Id></Link>)}</li>
                <li>{report.unchangedRecords.length} unchanged</li>
                {report.products > 0 && <li>{report.products} new product{report.products === 1 ? '' : 's'}{report.suppliers ? `, ${report.suppliers} new supplier${report.suppliers === 1 ? '' : 's'}` : ''}</li>}
                {report.updatedProducts.length > 0 && <li>{report.updatedProducts.length} product description/details updated</li>}
                {report.newAttributes.length > 0 && <li>New columns registered as attributes: {report.newAttributes.join(', ')}</li>}
              </ul>
              {report.skippedDocuments.length > 0 && <p className="small" style={{ marginTop: 8 }}>Documents not found and skipped: {report.skippedDocuments.join('; ')}</p>}
              <div className="row" style={{ marginTop: 10 }}>
                {report.createdRecords.length > 0 && <Link className="btn primary" to={`/qr-labels?codes=${report.createdRecords.join(',')}`}>Print the {report.createdRecords.length} new QR label{report.createdRecords.length === 1 ? '' : 's'}</Link>}
                <Link className="btn" to="/qr-labels">All QR labels</Link>
              </div>
            </div>
          )}
        </section>
        <section className="panel">
          <h2>Columns</h2>
          <table className="table">
            <thead><tr><th>Column</th><th>What to put</th></tr></thead>
            <tbody>{COLUMNS.map(([c, d, req]) => (
              <tr key={c}><td><span className="id">{c}</span>{req ? <div className="small" style={{ fontWeight: 600 }}>Mandatory</div> : <div className="small muted">Optional</div>}</td><td className="small">{d}</td></tr>
            ))}</tbody>
          </table>
          <p className="small muted" style={{ marginTop: 8 }}>A shipment is identified by supplier + part number + PO + line. Change any other value and re-import to update it. Extra columns are kept as additional attributes.</p>
        </section>
      </div>
    </>
  );
}
