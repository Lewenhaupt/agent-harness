import { defineProofPanelElement } from "./panel.js";

/**
 * Browser entry for the proof-of-work panel.
 *
 * Browser apiVersion 5 is required: only v5 panel contexts carry the package's
 * scoped `backend` and the paired `peer` the panel needs to read the receipt out
 * of the repository store through `server-plugin.js`. Bumping this also closes
 * bd-129's v4-deprecation item for this plugin; `pi-web-plugin.test.js` derives
 * the accepted versions from the installed host contract, so a host bump that
 * drops v5 fails the guard.
 */
const plugin = {
  apiVersion: 5,
  name: "Proof of Work",
  activate: ({ runtimePluginId, html, svg }) => {
    defineProofPanelElement();
    return {
      contributions: {
        actions: [
          {
            id: "workspace.open-proof-of-work",
            title: "Open Proof of Work",
            description: `View proof-of-work artifacts (per-task directories, external proof base).`,
            group: "Workspace",
            enabled: (context) => context.state.selectedWorkspace !== undefined,
            run: (context) => {
              if (context.state.selectedWorkspace === undefined) return;
              context.selectWorkspaceTool(`${runtimePluginId}:workspace.proof-of-work`);
            },
          },
        ],
        workspacePanels: [
          {
            id: "workspace.proof-of-work",
            title: "Proof of Work",
            icon: svg`
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
              </svg>
            `,
            order: 60,
            render: (context) => html`<pi-web-proof-of-work-panel .context=${context}></pi-web-proof-of-work-panel>`,
          },
        ],
      },
    };
  },
};

export default plugin;