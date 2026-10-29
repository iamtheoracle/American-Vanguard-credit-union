import { getUser, login, logout, handleAuthCallback, acceptInvite, requestPasswordRecovery, recoverPassword } from '@netlify/identity';

window.AVCUIdentity = Object.freeze({ getUser, login, logout, handleAuthCallback, acceptInvite, requestPasswordRecovery, recoverPassword });
