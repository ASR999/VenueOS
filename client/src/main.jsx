import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { applyStoredTheme } from './theme.js';
import './index.css';

// Before the first paint, so a dark-mode user never sees a white flash.
applyStoredTheme();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
