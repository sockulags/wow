# @wow/secrets

Secret store in `<WOW_HOME>/secrets.json`: values protected with DPAPI (current user) on Windows, a plain file with mode 0600 elsewhere. Settings keep a `{secretRef}` and the server resolves it here.
