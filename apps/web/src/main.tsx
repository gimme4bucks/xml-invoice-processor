import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ConfigError, loadConfig } from './config';
import './styles.css';

const root = createRoot(document.getElementById('root')!);

loadConfig().then(
  (config) =>
    root.render(
      <StrictMode>
        <App config={config} />
      </StrictMode>,
    ),
  (error: unknown) =>
    root.render(
      <main className="page">
        <h1>Support view</h1>
        <p role="alert" className="notice">
          {error instanceof ConfigError
            ? error.message
            : 'The configuration (/config.js) could not be loaded.'}
        </p>
      </main>,
    ),
);
