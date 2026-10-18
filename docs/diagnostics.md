# Save diagnostics

Open **About** from Settings to see the installed version, browser target and
source fingerprint. The fingerprint distinguishes builds even when they share
a release version.

On an affected website, open the toolbar popup and choose **Save diagnostics**.
The same button on About saves a general build and preferences report. Both
create a local JSON download only when clicked. Saving does not upload the file,
change preferences or start background collection.

The report includes the build identity, browser product and version, general
preferences and available status from the active page. It excludes site rules,
URLs, hostnames, page text, custom preview text and raw user-agent strings.
Errors are recorded only as present or absent, without their messages.

The popup can include page status because the website stays active underneath
it. About, restricted pages and pages that do not respond show page status as
unavailable. This does not mean the page is working correctly. Browser privacy
settings may also limit the reported browser version.

Review the downloaded file before sharing it. If the build identity is missing,
reload the extension in your browser's extension manager and reopen About.
Include that the identity is unavailable when reporting a problem.
