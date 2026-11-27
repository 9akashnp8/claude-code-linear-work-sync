import {atom, read, update} from "claude-code"
import { WORK_SUMMARIZER_SYSTEM_PROMPT } from "./prompt";
import { ISSUE_DETAIL_QUERY, parseLinearGqlResponse } from "./linear"
const LINEAR_API_BASE_URL = "https://api.linear.app/graphql";

const PLUGIN_NAME = "linear-work-sync";

// The engine reads atom refs statically, so plugin and key must be literals.
const summary = atom(
  { plugin: "linear-work-sync", key: "summary" },
  "",
);

// Session state, not $.store: it has to last exactly as long as the key that
// $.env.set holds, which is this process. It survives a hot reload, but a new
// session starts disconnected, as it has no key yet.
const connected = atom(
  { plugin: "linear-work-sync", key: "connected" },
  false,
);

// Resolves { nodes } with the issue list, or { error } saying why there is
// none, so a failed request never throws inside a render.
async function fetchIssues($) {
  if (!(await $.env.get("LINEAR_API_KEY"))) {
    return { error: "No Linear API key is set in this session" };
  }
  const response = await queryLinearGql(
    $,
    { "content-type": "application/json" },
    "POST",
    { query: "{ issues { nodes { id title } } }" },
  );
  let body;
  try {
    body = JSON.parse(response.text);
  } catch {
    return { error: `HTTP ${response.status}: the response was not JSON` };
  }
  const nodes = body?.data?.issues?.nodes;
  if (response.status !== 200 || !nodes) {
    const messages = (body?.errors ?? []).map((err) => err.message).join("; ");
    return {
      error: `HTTP ${response.status}: ${messages || "no issues in the response"}`,
    };
  }
  return { nodes };
}

async function queryLinearGql($, headers, method, data) {
  const response = await $.http.fetch(LINEAR_API_BASE_URL, {
    method: method,
    headers: {
      Authorization: `${await $.env.get("LINEAR_API_KEY")}`,
      ...headers,
    },
    body: JSON.stringify(data),
  });
  return response;
}

export function register(on) {
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "link-linear",
      description: "Link Linear issue",
    });
    await $.command.register({
      name: "linear-update",
      description: "Update linear linked issue",
    });
    return next(e);
  });

  on("command.run", { command: "link-linear" }, async ($) => {
    await $.ui.open({
      id: "linear-issue-linking-pane",
      title: "Link Linear Issue",
      focus: true,
      closeOnEscape: true,
    });
    return {};
  });

  on("command.run", { command: "linear-update" }, async ($) => {
    await $.ui.open({
      id: "linear-issue-update-pane",
      title: "Update Linear Issue",
      focus: true,
      closeOnEscape: true,
    });
    return {};
  });

  // on("session.receive", async ($, e, next) => {
  //   // e.origin.kind is 'peer' or 'peer-send-message' when it's from another session/subagent
  //   if (e.origin.kind === "peer" || e.origin.kind === "peer-send-message") {
  //     await $.ui.log("Subagent replied:", e.text);
  //     // Return { consumed: reason } to keep it from reaching Claude's context
  //     return { consumed: "handled by mod" };
  //   }
  //   await $.ui.log(JSON.stringify(e))
  //   return next(e); // pass other messages through unchanged
  // });

  on("ui.render", { component: "Pane" }, async ($, e, next) => {
    const sessionId = await $.session.id();
    if (e.requestId !== "linear-issue-linking-pane") return next(e);

    const { Box, Text, Button, Input, Select } = $.ui.resolve(e);

    const isConnected = await read($, connected);

    let issueNodes = [];
    let fetchError;
    if (isConnected) {
      const result = await fetchIssues($);
      if (result.error) fetchError = result.error;
      else issueNodes = result.nodes;
    }
    const showIssueForm = isConnected && !fetchError;

    const issueLinkForm = Box({
      children: [
        Select({
          key: "linear-issue-selection",
          label: "Select the Linear Issue you want to link to this session",
          options: issueNodes.map((n) => ({ value: n.id, label: n.title })),
          value: "",
          onSelect: async (value) => {
            // Merge into the existing map so other sessions keep their links.
            const sessionIssueMap =
              (await $.store.get("sessionIssueMap")) ?? {};
            await $.store.set("sessionIssueMap", {
              ...sessionIssueMap,
              [sessionId]: value,
            });
            await $.ui.log(`Session ${sessionId} linked to Issue: ${value}`);
            await $.ui.close({ id: "linear-issue-linking-pane" });
          },
        }),
      ],
    });

    return Box({
      children: [
        Box({
          flexDirection: "column",
          children: [
            Text({
              children: ["Link the Linear Issue that you want to work on"],
            }),
            Input({
              key: "linear-base-url",
              label: "Linear Base URL",
              placeholder: "Enter the Liner Organization Base URL",
              value: "",
              submitLabel: "add",
              autoFocus: true,
              onSubmit: async (value) => {
                if (!value.trim()) return;
                await $.env.set("LINEAR_API_KEY", value.trim());
                // A new key has not been tested yet.
                await update($, connected, () => false);
                await $.ui.log(
                  `Linear Credentials Captured! Use 'Test Connection' to validate the connection`,
                );
              },
            }),
            Button({
              key: "test-api",
              label: "Test Connection",
              onPress: async () => {
                const result = await fetchIssues($);
                // Writing the atom redraws the pane.
                await update($, connected, () => !result.error);
                if (result.error) {
                  await $.ui.log(`Linear connection failed: ${result.error}`);
                } else {
                  await $.ui.log("Linear Configuration Succesful!");
                }
              },
            }),
            ...(fetchError
              ? [
                  Text({
                    children: [
                      `Could not load Linear issues (${fetchError}). Enter your API key and test the connection again.`,
                    ],
                  }),
                ]
              : []),
          ],
        }),
        ...(showIssueForm ? [issueLinkForm] : []),
      ],
    });
  });

  on("ui.render", { component: "Pane" }, async ($, e, next) => {
    if (e.requestId !== "linear-issue-update-pane") return next(e);

    const sessionId = await $.session.id();
    const sessionIssueMap = (await $.store.get("sessionIssueMap")) ?? {};
    const linkedIssue = sessionIssueMap[sessionId];
    const redraw = () => $.ui.invalidate("ui.render");
    const { Box, Text, Button, Input, Select } = $.ui.resolve(e);

    if (!linkedIssue) {
      return Box({
        flexDirection: "column",
        children: [
          Text({
            children: [
              "No Linear issue is linked to this session. Run /link-linear first.",
            ],
          }),
        ],
      });
    }

    const text = await read($, summary)

    const agents = await $.agent.list();
    await $.ui.log(JSON.stringify(agents));
    const workSummarizerAgent = agents.find(
      (a) => a.type == `${PLUGIN_NAME}:work-summarizer`,
    );

    async function generateSummary() {
      await $.ui.log("Summary generation started");

      const issueDetail = await queryLinearGql(
        $,
        { "content-type": "application/json" },
        "POST",
        {
          query: ISSUE_DETAIL_QUERY,
          variables: {
            id: linkedIssue,
          },
        },
      );

      // The parser returns the GraphQL `data` object, which wraps the issue.
      const issue = parseLinearGqlResponse(issueDetail)?.issue;
      if (!issue) {
        await $.ui.log(
          `Could not load Linear issue ${linkedIssue}: ${issueDetail.text}`,
        );
        return;
      }

      update($, summary, () => issueDetail)

      await $.ui.log(`Text: ${JSON.stringify(issue)}`)
      const sessionMessages = await $.session.messages();

      // The system prompt promises previous updates oldest first, and the
      // Linear API has no sort direction, so sort here.
      const previousUpdates = [...(issue.comments?.nodes ?? [])]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((c) => `<update date="${c.createdAt}">\n${c.body}\n</update>`)
        .join("\n");
      const sessionTranscript = sessionMessages
        .map((m) => `<${m.role}>\n${m.text}\n</${m.role}>`)
        .join("\n");
      const sessionDate = new Date().toISOString().slice(0, 10);

      const prompt = `<issue>
<title>${issue.title}</title>
<description>
${issue.description ?? ""}
</description>
</issue>

<previous_updates>
${previousUpdates}
</previous_updates>

<session_date>${sessionDate}</session_date>

<session>
${sessionTranscript}
</session>

Write the update for this session.`;

      try {
        const r = await $.model.complete({
          model: "sonnet",
          system: WORK_SUMMARIZER_SYSTEM_PROMPT,
          prompt,
        });
        await $.ui.log(`Summary Response: ${JSON.stringify(r)}`);
        const answer = r.isAnswered ? r.text.trim() : "unknown";
        await $.ui.log(`Answer: ${answer}`);
      } catch (err) {
        await $.ui.log(`model.complete failed: ${err}`);
      }
    }

    return Box({
      children: [
        Box({
          flexDirection: "column",
          children: [
            Text({
              children: ["Update the Linear Issue with current progress"],
            }),
            Button({
              key: "generate-update-from-history",
              label: "Generate Update from history",
              onPress: async () => {
                await generateSummary();
              },
            }),
            Button({
              key: "clear-update-from-history",
              label: "Clear Update from history",
              onPress: async () => {
                update($, summary, () => '')
              },
            }),
            Text({
              children: [`Summary: ${JSON.stringify(text)}`]
            })
          ],
        }),
      ],
    });
  });
}
