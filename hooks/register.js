import {atom, read, update} from "claude-code"
import { WORK_SUMMARIZER_SYSTEM_PROMPT } from "./prompt";
import { ISSUE_DETAIL_QUERY, parseLinearGqlResponse } from "./linear"
const LINEAR_API_BASE_URL = "https://api.linear.app/graphql";

let sessionIssueMap = {};
let isConnectionSuccess = false;

const summary = atom({ plugin: 'first-mod', key: 'summary' }, '')

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
            await $.store.set("sessionIssueMap", { [sessionId]: value });
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
                  isConnectionSuccess = true;
                  redraw();
                  // await $.ui.close({ id: "linear-issue-linking-pane" });
                } else {
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
    const sessionIssueMap = await $.store.get("sessionIssueMap");
    const linkedIssue = sessionIssueMap[sessionId];
    const redraw = () => $.ui.invalidate("ui.render");
    const { Box, Text, Button, Input, Select } = $.ui.resolve(e);
    const text = await read($, summary)

    const agents = await $.agent.list();
    await $.ui.log(JSON.stringify(agents));
    const workSummarizerAgent = agents.find(
      (a) => a.type == "first-mod:work-summarizer",
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

      const issue = parseLinearGqlResponse(issueDetail)
      
      update($, summary, () => issueDetail)

      const text = await read($, summary)
      await $.ui.log(`Text: ${JSON.stringify(issue)}`)
      const sessionMessages = await $.session.messages();
      try {
        const r = await $.model.complete({
          model: "sonnet",
          system: WORK_SUMMARIZER_SYSTEM_PROMPT,
          prompt: `
          <issue>
            <title>${issue.title}</title>
            <description>
              ${issue.description}
            </description>
          </issue>

          <previous_updates>
          ${issue?.comments?.nodes.map((c) => {
            return `
            <update date="${c.createdAt}"> 
            ${c.body}
            </update>
            `
          })}
          </previous_updates>

          <session_date>${123}</session_date>

          <session>
          ${sessionMessages.map((m) => {
            return `
            <${m.role}>
            ${m.text}
            </${m.role}> 
            `
          })}
          </session>

          Write the update for this session.
          `,
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
