import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { sweepStaleDrafts } from './lib/chat-drafts';
import 'katex/dist/katex.min.css';
import './styles/globals.css';

sweepStaleDrafts();

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
