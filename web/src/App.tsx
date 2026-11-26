import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { Portal } from './api';
import { PortalSession, useSession } from './session';
import { Loading, TagMark } from './ui';
import { Login } from './pages/Login';
import { SupplierHome, Profile, ProfileGate } from './pages/Supplier';
import { ShipmentForm } from './pages/ShipmentForm';
import { Records, RecordDetail } from './pages/Records';
import { Scan, QrResult, PublicScan } from './pages/Scan';
import { LabelCheck } from './pages/LabelCheck';
import { ValidationRun, Validations } from './pages/Validation';
import { ImportCsv } from './pages/ImportCsv';
import { QrLabels } from './pages/QrLabels';

export function App() {
  return (
    <Routes>
      {/* Anyone who scans a label: no sign-in. */}
      <Route path="/t/:token" element={<PublicScan />} />
      <Route path="/supplier/*" element={<PortalSession portal="supplier"><SupplierPortal /></PortalSession>} />
      <Route path="/company/*" element={<PortalSession portal="company"><CompanyPortal /></PortalSession>} />
      <Route path="*" element={<Navigate to="/company" replace />} />
    </Routes>
  );
}

type NavItem = { to: string; label: string; end?: boolean };

function Shell({ portal, nav, children }: { portal: Portal; nav: NavItem[]; children: ReactNode }) {
  const { me, loading, signOut } = useSession();
  const loc = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => setMenuOpen(false), [loc.pathname]);
  useEffect(() => { document.title = portal === 'supplier' ? 'SPIR supplier portal' : 'SPIR company portal'; }, [portal]);

  if (loading) return <div className="page"><Loading what="Starting SPIR" /></div>;
  if (!me) return <Login portal={portal} />;

  return (
    <div className="shell">
      <aside className="rail">
        <NavLink to={`/${portal}`} className="brand" aria-label="Portal home">
          <TagMark className="brand-mark" />
          <div><div className="brand-name">SPIR</div><div className="brand-sub">{portal === 'supplier' ? 'Supplier portal' : 'Company portal'}</div></div>
        </NavLink>
        <button className="btn small menu-toggle" aria-expanded={menuOpen} aria-controls="main-nav" onClick={() => setMenuOpen((o) => !o)}>Menu</button>
        <nav id="main-nav" className={`nav${menuOpen ? ' open' : ''}`} aria-label="Main">
          {nav.map((i) => <NavLink key={i.to} to={i.to} end={i.end}>{i.label}</NavLink>)}
        </nav>
        <div className="rail-foot">Proof of concept. Both portals use the default sign-in for now.</div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="who">
            <span><strong>{me.supplier?.name ?? me.displayName}</strong> <span className="who-role">{portal === 'supplier' ? 'Supplier' : 'Company'}</span></span>
            <button className="btn small" onClick={signOut}>Sign out</button>
          </div>
        </header>
        <main className="page" id="main">{children}</main>
      </div>
    </div>
  );
}

function SupplierPortal() {
  const nav: NavItem[] = [
    { to: '/supplier', label: 'Overview', end: true },
    { to: '/supplier/shipments', label: 'Shipments', end: true },
    { to: '/supplier/shipments/new', label: 'Add a shipment', end: true },
    { to: '/supplier/import', label: 'Upload CSV' },
    { to: '/supplier/qr-labels', label: 'QR labels' },
    { to: '/supplier/profile', label: 'Profile' },
  ];
  return (
    <Shell portal="supplier" nav={nav}>
      <Routes>
        <Route index element={<SupplierHome />} />
        <Route path="profile" element={<Profile />} />
        <Route path="shipments" element={<ProfileGate><Records /></ProfileGate>} />
        <Route path="shipments/new" element={<ProfileGate><ShipmentForm /></ProfileGate>} />
        <Route path="shipments/:code" element={<RecordDetail />} />
        <Route path="shipments/:code/edit" element={<ProfileGate><ShipmentForm /></ProfileGate>} />
        <Route path="import" element={<ProfileGate><ImportCsv /></ProfileGate>} />
        <Route path="qr-labels" element={<ProfileGate><QrLabels /></ProfileGate>} />
        <Route path="*" element={<Navigate to="/supplier" replace />} />
      </Routes>
    </Shell>
  );
}

function CompanyPortal() {
  const nav: NavItem[] = [
    { to: '/company', label: 'Scan a QR code', end: true },
    { to: '/company/shipments', label: 'Search shipments' },
    { to: '/company/label-check', label: 'Check a product label' },
    { to: '/company/checks', label: 'Label check history' },
  ];
  return (
    <Shell portal="company" nav={nav}>
      <Routes>
        <Route index element={<Scan />} />
        <Route path="t/:token" element={<QrResult />} />
        <Route path="shipments" element={<Records />} />
        <Route path="shipments/:code" element={<RecordDetail />} />
        <Route path="label-check" element={<LabelCheck />} />
        <Route path="checks" element={<Validations />} />
        <Route path="checks/:code" element={<ValidationRun />} />
        <Route path="*" element={<Navigate to="/company" replace />} />
      </Routes>
    </Shell>
  );
}
