import { PROOF_OF_WORK_ROOT } from "./discovery.js";
import { defineProofPanelElement } from "./panel.js";

const plugin = {
  apiVersion: 2,
  name: "Proof of Work",
  activate: ({ runtimePluginId, html, svg }) => {
    defineProofPanelElement();
    return {
      contributions: {
        actions: [
          {
            id: "workspace.open-proof-of-work",
            title: "Open Proof of Work",
            description: `View proof-of-work artifacts (${PROOF_OF_WORK_ROOT}/).`,
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