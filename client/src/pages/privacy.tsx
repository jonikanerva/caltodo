export default function PrivacyPage() {
  return (
    <div className="px-4 py-10">
      <div className="max-w-3xl mx-auto space-y-8">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold">Privacy Policy</h1>
          <p className="text-sm text-muted-foreground">
            Todo connects to your Google Calendar to create and manage tasks.
          </p>
        </header>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Information I Collect</h2>
          <ul className="list-disc pl-5 space-y-2 text-sm text-muted-foreground">
            <li>
              Google account info: Google ID, email address, and display name (from Google
              OAuth).
            </li>
            <li>
              OAuth tokens: access and refresh tokens used to access your Google Calendar
              (stored encrypted).
            </li>
            <li>Calendar settings: the calendar ID you select for scheduling.</li>
            <li>
              Session data: a session ID cookie and CSRF token to keep you signed in.
            </li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Calendar Data</h2>
          <ul className="list-disc pl-5 space-y-2 text-sm text-muted-foreground">
            <li>
              Todo reads and writes events in your Google Calendar to create, update, and
              reschedule tasks.
            </li>
            <li>Tasks are stored in your Google Calendar, not in the app database.</li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">How I Use Information</h2>
          <ul className="list-disc pl-5 space-y-2 text-sm text-muted-foreground">
            <li>Authenticate you and maintain your session.</li>
            <li>Read and update calendar events to schedule tasks.</li>
            <li>Operate and secure the service.</li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Sharing</h2>
          <ul className="list-disc pl-5 space-y-2 text-sm text-muted-foreground">
            <li>I share data only with Google APIs to perform calendar operations.</li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Data Protection</h2>
          <ul className="list-disc pl-5 space-y-2 text-sm text-muted-foreground">
            <li>OAuth tokens are encrypted at rest before storage.</li>
            <li>Data is transmitted over HTTPS in production.</li>
            <li>
              Access to production data is restricted to the developer for support and
              operations.
            </li>
            <li>I request only the Google OAuth scopes needed to operate the app.</li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Data Retention & Deletion</h2>
          <ul className="list-disc pl-5 space-y-2 text-sm text-muted-foreground">
            <li>
              I retain Google account identifiers, encrypted OAuth tokens, and settings
              while your account remains connected to Todo.
            </li>
            <li>Session data expires after 7 days or when you log out.</li>
            <li>
              Calendar events created by Todo live in your Google Calendar and remain
              until you edit or delete them there.
            </li>
            <li>You can delete your stored records anytime in Settings.</li>
            <li>
              To delete stored data, revoke Todo&apos;s access in your Google Account
              settings and email the address listed on the app&apos;s OAuth consent
              screen; I will delete associated records within 30 days.
            </li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Google API Limited Use</h2>
          <p className="text-sm text-muted-foreground">
            Todo&apos;s use and transfer to any other app of information received from
            Google APIs will adhere to the Google API Services User Data Policy, including
            the Limited Use requirements.
          </p>
        </section>
      </div>
    </div>
  )
}
