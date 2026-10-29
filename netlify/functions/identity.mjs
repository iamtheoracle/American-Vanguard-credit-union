export default {
  userSignup(event) {
    const metadata = event.user.appMetadata || {};
    const roles = Array.isArray(metadata.roles) && metadata.roles.length ? metadata.roles : ['member'];
    return {
      user: {
        ...event.user,
        appMetadata: { ...metadata, roles }
      }
    };
  }
};
