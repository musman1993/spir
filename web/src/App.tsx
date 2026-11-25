import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ROLE_LABEL, type Role } from './api';
import { useSession } from './session';
import { Loading, TagMark, useApi } from './ui';
import { SignIn } from './pages/SignIn';
import { Home } from './pages/Home';
import { Products, ProductDetail } from './pages/Products';
import { Records, RecordDetail } from './pages/Records';
import { NewProduct, EditProduct, EditRecord } from './pages/SupplierForms';
import { ReviewQueue } from './pages/Review';
import { Scan, QrResult } from './pages/Scan';
import { LabelCheck } from './pages/LabelCheck';
import { ValidationRun, Validations } from './pages/Validation';
import { Audit } from './pages/Audit';
import { Settings } from './pages/Settings';

type NavItem = { to: string; label: string; roles?: Role[]; count?: number };

export function App() {
  const { me, loading, signOut } = useSession();
  const loc = useLocation();
  const isReviewer = me && ['COMPANY_REVIEWER', 'REGISTRY_ADMIN', 'AUDITOR'].includes(me.role);
  const [queue] = useApi<{ items: unknown[] }>(isReviewer ? '/review-queue' : null, [loc.pathname]);

  if (loading) return <div className="page"><Loading what="Starting SPIR" /></div>;
  if (!me) return <SignIn returnTo={loc.pathname} />;

  const supplier = me.role === 'SUPPLIER_CONTRIBUTOR';
  const groups: { name: string; items: NavItem[] }[] = [
    { name: 'Registry', items: [
      { to: '/', label: 'Overview' },
      { to: '/products', label: supplier ? 'My products' : 'Products' },
      { to: '/records', label: supplier ? 'My traceability records' : 'Traceability records' },
      { to: '/review', label: 'Review queue', roles: ['COMPANY_REVIEWER', 'REGISTRY_ADMIN', 'AUDITOR'], count: queue?.items.length },
    ] },
    { name: 'Inspection', items: [
      { to: '/scan', label: 'Scan a QR label', roles: ['QR_USER', 'INSPECTOR', 'COMPANY_REVIEWER', 'REGISTRY_ADMIN', 'AUDITOR'] },
      { to: '/label-check', label: 'Check a product label', roles: ['INSPECTOR', 'COMPANY_REVIEWER', 'REGISTRY_ADMIN'] },
      { to: '/validations', label: 'Label check history', roles: ['INSPECTOR', 'COMPANY_REVIEWER', 'REGISTRY_ADMIN', 'AUDITOR'] },
    ] },
    { name: 'Governance', items: [
      { to: '/audit', label: 'Audit trail', roles: ['AUDITOR', 'REGISTRY_ADMIN', 'COMPANY_REVIEWER'] },
      { to: '/settings', label: 'Attributes & label profiles' },
    ] },
  ];

  return (
    <div className="shell">
      <aside className="rail">
        <NavLink to="/" className="brand" aria-label="SPIR home">
          <TagMark className="brand-mark" />
          <div><div className="brand-name">SPIR</div><div className="brand-sub">Supplier product information registry</div></div>
        </NavLink>
        <nav className="nav" aria-label="Main">
          {groups.map((g) => {
            const items = g.items.filter((i) => !i.roles || i.roles.includes(me.role));
            if (!items.length) return null;
            return (
              <div key={g.name} style={{ display: 'contents' }}>
                <div className="nav-group">{g.name}</div>
                {items.map((i) => (
                  <NavLink key={i.to} to={i.to} end={i.to === '/'}>
                    {i.label}{i.count ? <span className="count">{i.count}</span> : null}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="rail-foot">Proof of concept with fictional suppliers and synthetic data.</div>
      </aside>
      <div className="main">
        <div className="demo-banner">Demo sign-in: anyone can switch roles. Don't enter real supplier or product data.</div>
        <header className="topbar">
          <div className="who">
            <span><strong>{me.displayName}</strong> <span className="who-role">{ROLE_LABEL[me.role]}{me.supplier ? `, ${me.supplier.name}` : ''}</span></span>
            <button className="btn small" onClick={signOut}>Switch role</button>
          </div>
        </header>
        <main className="page" id="main">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/products" element={<Products />} />
            <Route path="/products/new" element={<NewProduct />} />
            <Route path="/products/:code" element={<ProductDetail />} />
            <Route path="/products/:code/edit" element={<EditProduct />} />
            <Route path="/records" element={<Records />} />
            <Route path="/records/new" element={<EditRecord />} />
            <Route path="/records/:code" element={<RecordDetail />} />
            <Route path="/records/:code/edit" element={<EditRecord />} />
            <Route path="/review" element={<ReviewQueue />} />
            <Route path="/scan" element={<Scan />} />
            <Route path="/t/:token" element={<QrResult />} />
            <Route path="/label-check" element={<LabelCheck />} />
            <Route path="/validations" element={<Validations />} />
            <Route path="/validations/:code" element={<ValidationRun />} />
            <Route path="/audit" element={<Audit />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
