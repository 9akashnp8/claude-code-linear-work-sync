import {atom, read, update} from "claude-code"
import { WORK_SUMMARIZER_SYSTEM_PROMPT } from "./prompt";
import { ISSUE_DETAIL_QUERY, parseLinearGqlResponse } from "./linear"
const LINEAR_API_BASE_URL = "https://api.linear.app/graphql";

const PLUGIN_NAME = "claude-code-linear-work-sync";

const summary = atom({ plugin: PLUGIN_NAME, key: 'summary' }, '')

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

    const redraw = () => $.ui.invalidate("ui.render");

    // Persisted in the store so it survives a plugin reload.
    const isConnectionSuccess =
      (await $.store.get("isConnectionSuccess")) === true;

    let issueNodes = [{ id: "test", title: "test" }];
    if (isConnectionSuccess) {
      const linearIssues = await queryLinearGql(
        $,
        { "content-type": "application/json" },
        "POST",
        { query: "{ issues { nodes { id title } } }" },
      );

      let { text: response } = linearIssues;
      response = JSON.parse(response);

      let data = response.data;
      let issues = data.issues;
      issueNodes = issues.nodes;
    }

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
                await $.store.set("isConnectionSuccess", false);
                redraw();
                await $.ui.log(
                  `Linear Credentials Captured! Use 'Test Connection' to validate the connection`,
                );
              },
            }),
            Button({
              key: "test-api",
              label: "Test Connection",
              onPress: async () => {
                const response = await queryLinearGql(
                  $,
                  { "content-type": "application/json" },
                  "POST",
                  { query: "{ issues { nodes { id title } } }" },
                );
                const { status } = response;
                if (status == 200) {
                  await $.ui.log("Linear Configuration Succesful!");
                  await $.store.set("isConnectionSuccess", true);
                  redraw();
                  // await $.ui.close({ id: "linear-issue-linking-pane" });
                } else {
                  await $.store.set("isConnectionSuccess", false);
                  redraw();
                  await $.ui.log(
                    `Something went wrong: ${JSON.stringify(response)}`,
                  );
                }
              },
            }),
          ],
        }),
        ...(isConnectionSuccess ? [issueLinkForm] : []),
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
