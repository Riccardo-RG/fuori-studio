# Reuse approved work and shorten daily operations

## Create a procedure from a delivery

1. Open a completed assignment and select its latest approved delivery.
2. Choose **Create workflow** (**Crea procedura** in Italian).
3. Review the copied brief, responsible agents and step instructions. Generalize project-specific details and replace completed-work references with requirements for the next assignment. Set the expected final deliverable.
4. Keep the procedure as a draft, or mark it ready after reviewing it. Save explicitly.
5. Find it under **Memory → Workflows**. Choose **Use for a task**, select the intended project and provide the new task's title and materials. Saving creates a queued assignment; starting it remains a separate action.

This deterministic preparation uses no model call. It copies the original method's instructions, not AI answers, intermediate outputs, memory contents or source documents. It does not claim to discover the best method automatically. The original approved task and delivery version remain recorded in the procedure's provenance. Fields exceeding workflow limits are shortened with an explicit review notice.

The procedure starts in the delivery's original scope with no cross-scope sharing. Existing context evidence must still be valid when preparing and saving it. Changed or restricted memories block derivation because procedures currently lack individual-agent access restrictions. A manual, generalized procedure remains possible. Sharing a saved procedure is a separate, explicit edit.

These procedures orchestrate text analysis and drafting through the existing assignment engine. They are not executable scripts or automatic conversions of repository patches. Ready procedures also remain usable in chat, routines and portable knowledge archives. Editing a procedure creates a new version; existing assignments retain their recorded method and must satisfy the existing context freshness checks before execution.

## Quick actions

The bar below the page heading shows the current scope and offers **New task**, **New memory** and **Needs review**. Task creation uses the selected project or an available project in the current scope; when no project exists, the project form opens first. All forms remain editable before saving.

Press **Command K** on macOS or **Control K** on other keyboards, or click the bar's shortcut button, to open the searchable action menu. Search by the current interface language, use arrow keys to move, Enter to choose and Escape to close. Direct destinations include workflows, GitHub and repositories. Opening a destination does not make an AI call or read remote GitHub results.

**Needs review** combines text deliveries and repository runs requiring a decision, including paused and failed work. Superseded repository attempts with an already requested revision are excluded. Each entry opens its existing detailed review flow. The bar's count applies to the current scope; the work panel can additionally show all scopes. Approval, revision requests and external publication retain their existing controls.

The bar and menu support Italian, English, mobile layouts, keyboard focus and night mode. No additional runtime dependency is required.

## Read GitHub results

Use **GitHub → Test results** after connecting a credential with read access to Contents, Checks and Commit statuses for the selected repository. Results identify the exact commit and distinguish missing, incomplete and failed checks from success. Refresh is explicit and does not start CI jobs. See [GitHub checks](GITHUB_CHECKS.md) for limits, permissions and API details.
