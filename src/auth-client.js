import { getUser, login, logout, handleAuthCallback, acceptInvite } from '@netlify/identity';

window.AVCUIdentity = Object.freeze({ getUser, login, logout, handleAuthCallback, acceptInvite });
