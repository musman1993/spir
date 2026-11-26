import { ErrorBox, Loading, useApi } from '../ui';
import { useDefinitions } from './shared';

const METHOD: Record<string, string> = {
  identifier: 'Exact (case and spacing ignored; hyphens and leading zeros matter)', code: 'Governed code, with approved aliases',
  date: 'Date, parsed with the label profile formats', decimal: 'Number with configured tolerance', country: 'ISO country code, with aliases',
};

export function Settings() {
  const defs = useDefinitions();
  const [profiles, error] = useApi<{ profiles: any[] }>('/label-profiles');
  return (
    <>
      <div className="page-head">
        <h1>Attributes and label profiles</h1>
        <p className="lede">Attributes are governed metadata, not hard-coded columns. Adding a column to the seed CSV registers a new attribute automatically.</p>
      </div>
      <section className="table-wrap">
        {!defs ? <Loading /> : (
          <table className="table">
            <thead><tr><th>Attribute</th><th>Applies to</th><th>Type</th><th>Required</th><th>Label check</th><th>Comparison rule</th></tr></thead>
            <tbody>{defs.map((d) => (
              <tr key={d.key}>
                <td>{d.label}<div className="small muted id">{d.key} v{d.version}</div></td>
                <td>{d.scope === 'PRODUCT' ? 'Product' : 'Shipment record'}</td>
                <td className="small">{d.dataType.toLowerCase()}{d.unit ? `, ${d.unit}` : ''}{d.allowedValues ? <div className="muted">{d.allowedValues.join(', ')}</div> : null}</td>
                <td>{d.required ? 'Yes' : ''}</td>
                <td className="small">{d.labelChecked ? (d.critical ? 'Critical' : 'Checked') : ''}</td>
                <td className="small">{METHOD[d.comparisonRule?.method] ?? d.comparisonRule?.method}{d.comparisonRule?.aliases ? ` (${Object.keys(d.comparisonRule.aliases).length} aliases)` : ''}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>
      <h2 style={{ marginTop: 28 }}>Label profiles</h2>
      <ErrorBox error={error} />
      {profiles?.profiles.map((p) => (
        <section className="panel" key={p.key}>
          <h3>{p.name} <span className="muted small id">{p.key} v{p.version}</span></h3>
          <p className="small">Dates read as {p.config.dateFormats.join(', ')}. Reads below {Math.round(p.config.defaultConfidenceThreshold * 100)}% confidence need human review.</p>
          <table className="table">
            <thead><tr><th>Field</th><th>Words that introduce it on a sticker</th><th>Review below</th></tr></thead>
            <tbody>{Object.entries<any>(p.config.fields).map(([k, f]) => (
              <tr key={k}><td>{defs?.find((d) => d.key === k)?.label ?? k}</td><td className="small id" style={{ whiteSpace: 'normal' }}>{f.aliases.join(', ')}</td>
                <td className="small">{Math.round((f.confidenceThreshold ?? p.config.defaultConfidenceThreshold) * 100)}%</td></tr>
            ))}</tbody>
          </table>
        </section>
      ))}
    </>
  );
}
