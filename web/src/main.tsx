import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { App } from './App';
import './styles.css';

// HashRouter: GitHub Pages serves static files only, so routes live after the "#".
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
        <App />
    </HashRouter>
  </StrictMode>,
);
