# Mytikas user manual

Mytikas lets applicants apply to Olympus Mytikas and lets staff review applications
and confirm guild membership. This guide uses the fictional demo accounts. The
normal application has the same workflow, with live armory checks.

## Open the application

From the repository, start the demo and display its account credentials:

```sh
./mytikas.sh demo up
./mytikas.sh demo accounts
```

Open **[localhost:8081](http://localhost:8081)**. The yellow banner identifies the
demo: its armory results are fixtures and Discord notifications are disabled.
Choose **Apply / sign in** to open your account.

![Mytikas home page with the demo banner and Apply / sign in link](images/01-home.png)

For normal use, run `./mytikas.sh up` and open
**[localhost:8080](http://localhost:8080)**. Normal and demo accounts have separate
databases and session cookies, so you can sign in to both in the same browser.

## Create an account or sign in

New applicants complete **Apply to Mytikas**:

1. Enter an email address and a password of 12–128 characters.
2. Enter your full in-game character name and a motivation of up to 300 characters.
3. Read the current guild rules and check the acceptance box.
4. Choose **Create account & apply**. Your application is saved as **PENDING_EMAIL**.
5. Open the verification email and confirm the link, then sign in. Until verification, you are unauthenticated and staff cannot review the application. Verification preserves the submitted application and accepted rules.

Existing applicants use **Continue your ascent** and choose **Sign in**. Demo
accounts already exist: use the password shown by `demo accounts`. Use the password recovery page to request a 30-minute reset link; production requires configured mail delivery. Resetting an unverified account does not verify it. Verification links last 24 hours. Resend/correct-address actions require your credentials and invalidate older links; respect the displayed cooldown. Demo mail is captured locally.

![Account page showing the sign-in form, application form, and rules acceptance](images/02-sign-in-and-apply.png)

## Follow your application

For this example, sign in as **submitted@demo.test**. Your account shows your
character, current status, submission history, and application timeline. Staff
review notes appear in that timeline. A submitted application cannot be edited;
staff must reopen it before you can revise it.

![Submitted applicant view with status and application timeline](images/03-submitted.png)

| Status | What it means / next step |
| --- | --- |
| PENDING_EMAIL | Verify your email before signing in or staff review. |
| REMOVED | Membership access has ended; history is retained. An administrator can restore membership, but cleared roster assignments stay empty. |
| SUBMITTED | Await staff review. |
| APPROVED | Staff approved the application; join the guild in game, then confirm membership. |
| REJECTED | Read the review note; staff can reopen the application for corrections. |
| REOPENED | Revise the application and accept the current rules before resubmitting. |
| JOINED | Membership has been confirmed. |

Use **Sign out** before switching demo accounts. Signing out of the demo preserves
your normal application login.

## Review applications as staff

Sign in as **admin@demo.test** or **moderator@demo.test**, then choose **Admin
panel**. Select **Demo Submitted** from the pending queue. Use **Show applications**
to filter by status or view all applications.

Review the motivation, accepted rules, submission history, and timeline. Add a
**Review note (visible to applicant)** when useful, then choose an available action:

- **Approve** moves a submitted application to Approved.
- **Reject** declines a submitted or approved application.
- **Reopen** lets a rejected applicant revise and resubmit.
- **Check now** verifies an approved character's guild membership.
- **Mark as joined** records a staff-confirmed invitation for an approved applicant.

![Staff queue with Demo Submitted selected, a review note, and Approve and Reject actions](images/04-staff-review.png)

Armory matching confirms membership only. Staff should verify character ownership
during review or the in-game invitation. **Refresh queue** updates the selected
application and queue after worker activity or changes made by another staff member.

Administrators also have **Admin tools · rules and account roles** for publishing
new rules and finding accounts to change their roles. Moderators can review
applications but cannot use those administrator tools. For a new normal database,
create the first administrator with `./mytikas.sh admin` in a terminal.

## Revise a reopened application

Sign in as **reopened@demo.test**. Read the staff note and scroll to **Revise your
application**. Update your character or motivation, read and accept the current
rules, then choose **Resubmit application**. The status returns to Submitted for
another staff review.

![Reopened application with the revision form and current rules](images/05-revise-application.png)

Open **Submission history** to compare revisions. Each revision retains the
motivation and rules accepted at that time; publishing new rules does not rewrite
previous submissions. Sign in as **resubmitted@demo.test** to inspect an existing
two-revision example:

![Two immutable submission revisions showing their accepted demo rules](images/06-submission-history.png)

## Confirm membership

After approval, the worker checks membership periodically. Applicants and staff
can also choose **Check now**, subject to a shared one-minute cooldown. Successful
verification moves the application to Joined. A missing profile, different guild,
or armory outage leaves it Approved; staff can confirm membership manually when
appropriate.

To try this safely in the demo, use **approved@demo.test**, whose character starts
outside the guild:

```sh
./mytikas.sh demo armory approved@demo.test member
./mytikas.sh demo check approved@demo.test
```

The check should return `MATCH`. Reload the account page to see Joined. If a check
was requested in the previous minute, wait for the cooldown and try again.
**armory@demo.test** already demonstrates the final result:

![Joined application showing membership confirmed through the armory](images/07-joined.png)

For the automatic path, approve **Demo Submitted** as staff. Its fixture is already
`member`, so the worker can confirm joining on its next cycle. Refresh the queue
or reload the applicant page to see the result.

## Demo accounts and fixtures

All demo accounts use the generated password printed by `demo accounts`.

| Account | Initial scenario |
| --- | --- |
| admin@demo.test | Administrator without an application |
| moderator@demo.test | Moderator without an application |
| submitted@demo.test | Submitted; member fixture |
| approved@demo.test | Approved; outsider fixture |
| rejected@demo.test | Rejected with a review note |
| reopened@demo.test | Ready for applicant revision |
| resubmitted@demo.test | Submitted with two revisions |
| manual@demo.test | Joined manually |
| armory@demo.test | Joined through the armory |

Use `./mytikas.sh demo summary` to inspect counts and fixture states. The armory
command accepts `member`, `outsider`, `missing`, or `unavailable` and targets the
applicant's current character. Unknown character profiles return 404. Demo checks
never contact Blizzard; Discord is disabled.

## Stop, resume, back up, or reset

```sh
./mytikas.sh demo down       # stop; keep the demo database
./mytikas.sh demo up         # start again; preserve walkthrough changes
./mytikas.sh --demo backup   # create a private database dump
./mytikas.sh demo reset --yes # discard demo changes and restore all examples
```

Reset removes only the demo database volume. It keeps the demo password and the
normal application's database. `demo seed` preserves existing walkthrough changes;
use reset when you need the initial examples again.

For normal operation, omit `demo` or `--demo`. Use `start` to resume existing
containers and `restart` to restart them. Use `up` to apply source or environment
changes. If the app is unavailable, check `./mytikas.sh --demo health`,
`./mytikas.sh --demo status`, and `./mytikas.sh --demo logs app worker`.
`./mytikas.sh --demo doctor` checks prerequisites and configuration.

See the [README](../README.md#compose-operations-helper-and-isolated-demo) for the
complete helper reference and verification results.

## Refresh these screenshots

With the freshly seeded demo running, run:

```sh
node --import tsx scripts/manual-screenshots.ts
```

The script captures the actual website using Playwright and checks the expected
states. It signs in to fictional demo accounts and fills an unsaved staff note;
it does not submit changes. Screenshots contain no passwords. If a walkthrough
has changed the examples, reset the demo before regenerating screenshots.

## Public prototype differences

The public landing stays at `https://mytikas.monster`; account and staff pages use `https://app.mytikas.monster` once cutover is completed. Availability depends on the laptop, Docker/WSL and tunnel being running. The landing remains readable during an outage and offers a status retry. Public deployment is not yet externally accepted; consult the implementation tracker before sharing it.

Registration sends the character name, motivation, accepted rules version, revision reference and review link to private staff Discord. It does not send email, passwords or sessions. Password recovery is unavailable. Discord review links preserve their application destination through staff login. If a submission response is lost, the page checks authoritative state; if the outcome remains uncertain it preserves your text and disables another attempt until you sign in/reload to confirm. It does not automatically repeat a submission.

## Email confirmation and recovery

New registrations reserve the character and save the accepted rules version. Check your inbox (including spam) and open the confirmation link, then press **Verify email**. Only then does the application enter staff review and queue its Discord notification. Sign in afterward. Existing accounts retain access through an explicit activation exemption; this is not recorded as email verification.

The confirmation-pending screen offers **Resend verification** and **Correct email**. Correction requires the original address and signup password and preserves your application. Replacement links invalidate earlier links. Wait at least 60 seconds between requests; requests are also limited per address and IP. Verification links expire after 24 hours.

Use **Forgot password?** on sign-in to request a reset. The acknowledgement is the same for all addresses. Reset links expire after 30 minutes. Enter and confirm a password of 12–128 characters. A successful reset signs out every existing session and sends a password-change notification. Resetting a pending account does not verify its email.

## Raid Roster

Confirmed members and administrators see **Raid Roster** in account and staff navigation. Moderators need confirmed membership and have read-only roster access. The public landing navigation is unchanged.

The 10, 20 and 40 player rosters always contain five columns. On phones, scroll within each roster to see the remaining columns. Blue means tank, green healer and red DPS; every role also has a text label. Character names use class colors; unknown classes remain assignable.

Administrators open **Edit Raid Rosters** in the admin panel. Activate a slot with a click or Enter, choose a member (or **Empty slot**) and a role, then **Apply to draft**. **Save** commits that complete roster; **Cancel** reloads that roster. Members can occupy one slot per roster and appear in all three rosters. If another administrator saves or removes a member, a stale save is rejected while your draft remains visible. Cancel to reload before editing again.

Under **Member classes**, select a manual class or **Use armory class** and save. **Refresh armory class** queues an independent fetch; it never changes membership or overwrites manual overrides.

For a joined member, administrators can enter a review note and select **Remove membership**. This immediately removes roster access and clears all assigned slots. **Restore membership** requires another reason and restores access with slots remaining empty. Both actions remain in immutable application history. Removing an administrator's membership does not change their administrative role.
