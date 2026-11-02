import { defineDurableMemberPanelElement } from "./panel.js";

/**
 * Browser entry for the durable-member panel.
 *
 * Browser apiVersion 5 (not the deprecated v4 that proof-of-work still uses) is
 * required here: only v5 panel contexts carry `context.backend`, and the panel
 * needs it to open the `watch` channel and forward control commands to the
 * server module. `pi-web-plugin.test.js` derives the accepted versions from the
 * installed host contract, so a host bump that drops v5 fails the guard.
 */
const plugin = {
  apiVersion: 5,
  name: "Durable Member",
  activate: ({ runtimePluginId, html, svg }) => {
    defineDurableMemberPanelElement();
    return {
      contributions: {
        actions: [
          {
            id: "workspace.open-durable-member",
            title: "Open Durable Member",
            description:
              "Observe and steer durable members: transcript, live generation, task graph, controls.",
            group: "Workspace",
            enabled: (context) => context.state.selectedWorkspace !== undefined,
            run: (context) => {
              if (context.state.selectedWorkspace === undefined) return;
              context.selectWorkspaceTool(`${runtimePluginId}:workspace.durable-member`);
            },
          },
        ],
        workspacePanels: [
          {
            id: "workspace.durable-member",
            title: "Durable Member",
            icon: svg`
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 7h16M4 12h10M4 17h7"></path>
                <circle cx="19" cy="12" r="1.5"></circle>
                <circle cx="19" cy="17" r="1.5"></circle>
              </svg>
            `,
            order: 61,
            render: (context) =>
              html`<pi-web-durable-member-panel .context=${context}></pi-web-durable-member-panel>`,
          },
        ],
      },
    };
  },
};

export default plugin;
