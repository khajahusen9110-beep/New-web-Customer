import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { captureAgentCodeFromUrl } from './lib/agentCode';
import './styles.css';

// Must run before the router sees the URL: an agent's shared link (?agent=CODE) is stashed
// for apply after signup/login, then the ?agent= param is otherwise ignored by routing.
captureAgentCodeFromUrl();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
