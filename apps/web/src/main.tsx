// Fonts and styles are side-effect imports by design: Vite bundles them into the page.
// oxlint-disable-next-line import/no-unassigned-import
import '@fontsource-variable/inter';
// oxlint-disable-next-line import/no-unassigned-import
import '@fontsource-variable/jetbrains-mono';
// oxlint-disable-next-line import/no-unassigned-import
import './styles/app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/app';
import { createRuntime } from './app/bootstrap';
import { createAppRouter } from './app/router';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <App runtime={createRuntime()} router={createAppRouter()} />
  </StrictMode>,
);
