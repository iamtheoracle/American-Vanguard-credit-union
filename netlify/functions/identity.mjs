export default {
  userSignup(event) {
    const current = Array.isArray(event.user.appMetadata?.roles) ? event.user.appMetadata.roles : [];
    const roles = [...new Set([...current.filter(role => role !== "admin"), "member"])];
    return {
      user: {
        ...event.user,
        appMetadata: { ...event.user.appMetadata, roles }
      }
    };
  }
};