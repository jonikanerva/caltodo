export default function TermsPage() {
  return (
    <div className="px-4 py-10">
      <div className="max-w-3xl mx-auto space-y-8">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold">Terms of Service</h1>
          <p className="text-sm text-muted-foreground">
            CalTodo is a personal project that connects to your Google Calendar to create
            and manage tasks.
          </p>
        </header>

        <section className="space-y-3">
          <p className="text-sm text-muted-foreground">
            By using the service, you agree to these terms.
          </p>
          <ul className="list-disc pl-5 space-y-2 text-sm text-muted-foreground">
            <li>The service is provided &quot;as is&quot; without warranties.</li>
            <li>You are responsible for your account and calendar content.</li>
            <li>Do not misuse the service or attempt unauthorized access.</li>
            <li>I may change or discontinue the service at any time.</li>
            <li>Google API usage is governed by Google&apos;s terms.</li>
            <li>See the Privacy Policy for data details.</li>
          </ul>
        </section>
      </div>
    </div>
  )
}
