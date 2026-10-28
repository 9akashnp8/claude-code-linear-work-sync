
export const ISSUE_DETAIL_QUERY = `
query IssueContext($id: String!) {
  issue(id: $id) {
    id
    identifier
    title
    description
    url
 
    # Current status, so the model's suggested status starts from where the issue is now
    state {
      name
      type        # backlog | unstarted | started | completed | canceled
    }
 
    # Parent issue, if this is a sub-issue. Gives the model the larger goal.
    parent {
      identifier
      title
    }
 
    # Comments come back in createdAt order, but the API has no sort direction,
    # so sort client-side to be safe.
    comments(first: 100) {
      nodes {
        id
        body
        createdAt
        user {
          name
          isMe      # true for comments posted with your API key
        }
        parent {
          id        # non-null means it's a reply in a thread
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}
`

export function parseLinearGqlResponse(rawGqlResponse) {
    const parsed = JSON.parse(rawGqlResponse.text)
    return parsed.data
}