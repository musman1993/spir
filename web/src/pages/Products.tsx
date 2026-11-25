import { Link, useParams } from 'react-router-dom';
import { useSession } from '../session';
import { Chip, ErrorBox, Id, Loading, fmtDate, fmtDay, useApi } from '../ui';
import { AttributeList, useDefinitions, useSearch } from './shared';

export function Products() {
  const { me } = useSession();
  const [q, setQ, dq] = useSearch();
  const [data, error] = useApi<{ products: any[] }>(`/products?q=${encodeURIComponent(dq)}`);
  const supplier = me!.role === 'SUPPLIER_CONTRIBUTOR';
  return (
    <>
      <div className="spread page-head">
        <div>
          <h1>{supplier ? 'My products' : 'Products'}</h1>
          <p className="lede">A product is a stable identity. Its manufacturing runs are separate traceability records.</p>
        </div>
        {supplier && <Link className="btn primary" to="/products/new">Register a product</Link>}
      </div>
      <div className="row" style={{ marginBottom: 12 }}>
        <input className="search" type="search" placeholder="Search by product ID, name or part number" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search products" />
      </div>
      <ErrorBox error={error} />
      {!data && !error && <Loading />}
      {data && (data.products.length === 0 ? (
        <div className="empty">{dq ? 'No products match that search.' : supplier ? 'You have not registered any products yet. Start with "Register a product".' : 'No approved products yet.'}</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Product ID</th><th>Name</th><th>Supplier part number</th>{!supplier && <th>Supplier</th>}<th>Material</th><th>Status</th><th>Records</th></tr></thead>
            <tbody>
              {data.products.map((p) => (
                <tr key={p.code}>
                  <td><Link to={`/products/${p.code}`}><Id>{p.code}</Id></Link></td>
                  <td>{p.name}</td>
                  <td><Id>{p.supplierPartNumber}</Id></td>
                  {!supplier && <td>{p.supplierName}</td>}
                  <td><Id>{p.attributes?.body_material_grade ?? '-'}</Id></td>
                  <td>{p.approvedVersion ? <Chip status="APPROVED" /> : <Chip status={p.latestStatus} />}{p.openStatus && p.approvedVersion ? <> <Chip status={p.openStatus} /></> : null}</td>
                  <td>{p.traceabilityCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </>
  );
}

export function ProductDetail() {
  const { code } = useParams();
  const { me } = useSession();
  const defs = useDefinitions();
  const [p, error] = useApi<any>(`/products/${code}`);
  if (error) return <ErrorBox error={error} />;
  if (!p) return <Loading />;
  const supplier = me!.role === 'SUPPLIER_CONTRIBUTOR';
  const shown = p.approved ?? p.versions[0];
  const open = p.versions.find((v: any) => v.status === 'DRAFT' || v.status === 'PENDING');
  const latest = p.versions[0];
  return (
    <>
      <div className="spread page-head">
        <div>
          <p className="muted small" style={{ marginBottom: 4 }}><Link to="/products">Products</Link></p>
          <h1>{shown?.productName}</h1>
          <div className="row"><Id>{p.code}</Id><Chip status={p.approved ? 'APPROVED' : latest?.status} />{open && p.approved && <Chip status={open.status} />}</div>
        </div>
        {supplier && (
          <div className="row">
            {open?.status !== 'PENDING' && <Link className="btn" to={`/products/${p.code}/edit`}>{open ? 'Continue draft' : 'Propose a change'}</Link>}
            <Link className="btn primary" to={`/records/new?product=${p.code}`}>Add a manufacturing record</Link>
          </div>
        )}
      </div>
      {latest?.status === 'REJECTED' && supplier && <div className="notice error" style={{ marginBottom: 16 }}>Version {latest.versionNo} was rejected: {latest.reviewComment}</div>}
      <div className="grid-2">
        <div className="stack">
          <section className="panel">
            <h2>Product identity</h2>
            <dl className="facts">
              <dt>Supplier</dt><dd>{p.supplier.name} <span className="muted"><Id>{p.supplier.code}</Id></span></dd>
              <dt>Category</dt><dd>Cast valve body</dd>
              {p.identifiers.map((i: any) => (
                <div key={i.type + i.value} style={{ display: 'contents' }}>
                  <dt>{i.type === 'SUPPLIER_PART_NUMBER' ? 'Supplier part number' : i.type === 'MANUFACTURER_PART_NUMBER' ? 'Manufacturer part number' : i.type}</dt>
                  <dd><Id>{i.value}</Id></dd>
                </div>
              ))}
              {shown?.description && <><dt>Description</dt><dd>{shown.description}</dd></>}
            </dl>
          </section>
          <section className="panel">
            <h2>{p.approved ? `Approved attributes, version ${p.approved.versionNo}` : `Attributes, version ${shown?.versionNo} (not approved)`}</h2>
            <AttributeList defs={defs} scope="PRODUCT" values={shown?.attributes ?? {}} />
          </section>
          <section className="panel">
            <h2>Traceability records</h2>
            {p.traceability.length === 0 ? <p className="muted">No manufacturing records yet.</p> : (
              <table className="table">
                <thead><tr><th>Record</th><th>Heats</th><th>Manufactured</th><th>Status</th></tr></thead>
                <tbody>
                  {p.traceability.map((t: any) => (
                    <tr key={t.code}>
                      <td><Link to={`/records/${t.code}`}><Id>{t.code}</Id></Link>{t.externalRef && <div className="small muted">Supplier ref {t.externalRef}</div>}</td>
                      <td><Id>{(t.heats ?? []).join(', ')}</Id></td>
                      <td>{fmtDay(t.manufacturingDate)}</td>
                      <td>{t.approvedVersion ? <Chip status="APPROVED" /> : <Chip status={t.latestStatus} />}{t.openStatus && t.approvedVersion ? <> <Chip status={t.openStatus} /></> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
        <section className="panel">
          <h2>Version history</h2>
          <ol className="timeline">
            {p.versions.map((v: any) => (
              <li key={v.id} className={v.status}>
                <div className="row"><strong>Version {v.versionNo}</strong><Chip status={v.status} /></div>
                <div className="small muted">Created {fmtDate(v.createdAt)}{v.reviewedAt ? `, reviewed by ${v.reviewedBy} ${fmtDate(v.reviewedAt)}` : ''}</div>
                {v.reviewComment && <div className="small">"{v.reviewComment}"</div>}
              </li>
            ))}
          </ol>
        </section>
      </div>
    </>
  );
}
