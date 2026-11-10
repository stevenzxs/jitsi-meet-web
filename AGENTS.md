# jitsi-meet-web build and deployment rules

- Keep `VITE_JITSI_SERVER` in `.env` at `https://118.193.36.35:8443` (user-approved FRP migration, 2026-10-22). Do not override it unless the user explicitly requests a configuration change.
- `192.168.199.202` is the SSH and Web deployment target. `https://118.193.36.35:8443` is the public entry via FRP, independent of the test VPN. The legacy 104 and internal 202 URLs are distinct browser origins.
- Build with `npm run build` using the checked-in configuration. Before publishing, inspect the generated JavaScript for the Jitsi URL. Reject a candidate intended for the default Electron entry if it embeds `https://192.168.199.202` as the Jitsi iframe origin.
- DOM access to the Jitsi iframe, including video click interception and strict grid layout, requires the meeting page and Jitsi iframe to share a browser origin. If both public and internal entry points must work, solve origin selection in application runtime code; do not alternate `VITE_JITSI_SERVER` values between builds.
- Before declaring a Web release successful, verify actual page and Jitsi iframe origins through the 118 public entry and verify the new static asset is served there. A successful build or `/cm/` HTTP 200 alone does not prove the iframe is same-origin. Self-signed HTTPS is explicitly pinned in Electron; never globally disable certificate validation.
