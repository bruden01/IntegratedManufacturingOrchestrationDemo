import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { AuthProvider } from './contexts/AuthContext.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <AuthProvider>
    <ProtectedRoute>
      <App />
    </ProtectedRoute>
  </AuthProvider>
);
