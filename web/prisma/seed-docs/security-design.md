# IAM Engine — Security Design

IAM Engine Security Design: how the platform is secured, and why each decision was made

This document is written for the person whose job is to say no. It does not summarize our security controls; it explains the reasoning behind each one: what we were defending against, what we considered, what we chose, and what the choice costs. Where we have not finished something, it is in section 12, stated plainly.

The claim this document defends. An automation platform that can create and delete identities across your estate is, by construction, a high-value target. We have therefore built it so that compromising the platform does not compromise your estate. The system that executes the work holds no standing credentials. The system that holds the references cannot execute. The vault that holds the values is reachable by neither in a standing way. And nothing irreversible happens without a named human.

## 1. Executive summary

For a reviewer who reads one page:

| Question | Answer |
| --- | --- |
| Where do our credentials live? | In CoreSecret. Never in the application. The application database has no field capable of holding a credential value, only a vault reference. This is enforced by the data model, not by policy. |
| What does the agent in our network hold? | Nothing standing. It has no vault credentials and cannot talk to the vault. It receives one credential, for one job, at the moment of execution, holds it in memory, and discards it. Compromising the agent host does not yield the vault. |
| Do you need inbound access to our network? | No. The agent makes outbound HTTPS connections only. It exposes no listening port. No inbound firewall rule is required, and none should be created. If you turn the agent off, we lose the ability to act: we hold no back door. |
| What access do you have in our tenant? | An application registration you create, you own, and you can revoke unilaterally, with a discrete, enumerable permission set. Not a Global Administrator account. It cannot grant itself further permissions. |
| Why certificates for Microsoft 365? | Because a client secret is a password that travels; a certificate is a key that proves possession without ever being transmitted. Microsoft requires it for Exchange app-only auth. Section 4. |
| What stops the platform doing something irreversible? | Destructive steps are classified at plan time, always require approval, and are physically withheld from runners until approved. The gate is at dispatch, not in the UI. The person who runs a case cannot, by default, approve its destructive steps. |
| Can you prove what was done? | An append-only audit log across roughly 112 action types, an immutable per-result run history, evidence captured before removal, and a work note on every originating ticket. |

## 2. Design principles

Five principles generated most of the specific decisions in this document. Where a later section explains a choice, it usually reduces to one of these.

### 2.1 Assume the platform is breached

We do not design as though the application will hold. We design so that when it does not, the blast radius is bounded. This is why the runner cannot reach the vault, why credentials are brokered per job rather than held, why sessions are hashed at rest, and why the agent has no standing rights. Every one of those is a decision that makes the normal case slightly harder in order to make the bad case survivable. Section 10 states, layer by layer, what an attacker actually gets.

### 2.2 Least privilege by construction, not by configuration

A control that can be switched off in a settings screen is a control that will eventually be switched off at 2am by someone under pressure. Where a boundary matters, we build it so that it cannot be configured away: a job can only request the secrets on its own allowlist, a destructive step's approval requirement cannot be disabled, an agent can only enroll as the client its token was minted for.

### 2.3 Fail closed

A missing configuration must never resolve to an open door. If the machine API’s token is not configured, the endpoints return an error rather than accepting anyone. The endpoints that carry credentials fail closed in every environment, including development, because "no token configured" must never mean "serve tenant-administrator credentials to an unauthenticated caller."

### 2.4 Reversible by default; irreversible by exception

Offboarding is the dangerous direction. We separate containment (disable, remove groups, revoke sessions, all reversible) from destruction (delete a mailbox, hard-delete an identity, shut down a device, not reversible). Containment runs on the normal path, fast, because speed is the point. Destruction is gated behind a human every time.

### 2.5 Honesty is a security control

A security document that overclaims teaches its reader to distrust the parts that are true. We have therefore removed several claims we would have liked to make. We do not claim mutual TLS, because we have not shipped it. We do not claim automated credential rotation, because rotation is currently manual. Section 12 lists what is not done. We would rather you read it from us.

## 3. The credential architecture

This is the core of the design, and the section worth reading closely. Everything else is defense in depth around it.

### 3.1 Decision: the platform stores no secrets

The problem. An automation platform needs credentials to roughly everything you own: your identity provider, your mail platform, your endpoint agent, your backup product. The naive design puts those credentials in the platform's database, encrypted at rest. That design has a single catastrophic failure mode: the platform's database becomes a complete, decryptable set of keys to your entire estate, and the application by definition holds the decryption key, because it has to use them.

The decision. Every credential lives in CoreSecret. The application database holds a vault reference, an ID and a label, and nothing else. There is no schema field in the platform capable of holding a credential value. The client configuration profiles are the same: they carry references, never values.

What this costs us. Every execution requires a vault round trip. We accepted that latency deliberately.

What it buys. A dump of the application database yields a list of the names of your secrets and a set of opaque vault IDs. It does not yield a single credential. An attacker holding it still has to compromise the vault, separately, with different credentials, and the vault's own access log records the attempt.

### 3.2 Decision: the runner does not talk to the vault

This is the single most consequential decision in the platform, and the one we would most like you to scrutinize.

The problem. Something has to execute against Active Directory, and that something has to run inside your network, on a domain-joined host, frequently the domain controller itself. That host is, by a wide margin, the most exposed component of the whole system. It sits in your LAN, adjacent to everything an attacker who is already inside would want.

The obvious design gives that agent a vault credential so it can fetch what it needs. That design is a disaster, and it is worth being explicit about why: it means that a compromise of one machine inside one client's network, a machine we do not control, on a network we cannot see, yields a standing credential to the vault. And the vault holds the keys to every other client too.

The decision: push-down brokering. The runner has no vault credentials. It does not know how to talk to CoreSecret, and the module that once let it do so has been removed from its load path. Instead, when a runner needs to act, it asks the application for the one credential its current job requires, and the application, which does hold vault credentials, in a controlled environment we operate, resolves that single secret and pushes the value down over the authenticated job channel.

#### The four checks made before any value is released

The application will not resolve a secret until all four pass:

- The job exists, and this runner owns it. A runner cannot request a credential for a job assigned to a different runner. Identity of the requester is checked against the assignment, not merely against the fleet.

- The runner is enabled. A runner an operator has disabled is refused mid-flight, not just at claim time. Disabling an agent stops it claiming work, brokering credentials, and posting results, immediately.

- The job is actually in progress. Credentials are not brokered for jobs that are pending, complete, or failed. There is no window in which a finished job can still pull a secret.

- The requested secret is on that job's own allowlist. This is the one that matters most. Every job carries the specific secret names it is permitted to request. A runner executing a Zoom step cannot ask for the Active Directory credential. It cannot ask for any credential other than the ones its current, legitimate job needs. There is no endpoint that says "give me secret X," only "give me the secret my job is entitled to."

The value is then returned with cache headers that forbid any intermediary from retaining it. The request is written to the audit log. The value is not.

#### What the agent on your domain controller actually holds

No standing access to any credential whatsoever. Not to the vault, not to your tenant, not to any other client. An attacker who fully compromises that host, SYSTEM, root of the box, obtains, at most, the credentials for the jobs currently executing on it in that moment. They do not obtain a key that keeps working tomorrow, and they obtain nothing at all about any other client.

### 3.3 In memory, for the life of the job, and no longer

The runner holds the brokered credential as a protected in-memory object for the lifetime of the job. It is never written to disk. It is never written into a configuration file or a profile. It is never cached for a later job. When the job ends, the process's reference to it ends.

### 3.4 Decision: scrub secrets by shape, not only by name

The problem. The classic credential leak is not a database breach. It is an error message. A stack trace containing a connection string, pasted into a ticket by a helpful engineer, now living forever in a system with far weaker access controls than the vault it came from.

The naive defense redacts fields whose name looks secret: anything called password, token, key. This works right up until a vendor’s API returns its credential in a field called something you did not anticipate, and it sails straight through.

The decision. Before any failure text leaves a runner, it passes through a scrubber that removes two classes of thing:

- Values of fields whose name suggests a secret: password, secret, key, token, credential, certificate, private, and so on.

- Any value carrying the structural signature of an encoded blob, slashes, plus signs, equals signs, braces, quotes, whitespace, above a length threshold, regardless of what the field is called. A base64 string, a JSON blob, or a PEM block is never a hostname. So it is scrubbed on its shape alone, and a secret arriving in a field we did not predict is caught anyway.

It also scrubs generated passwords, and the runner's own API token, so a runner cannot leak its own identity into an error message.

Usernames and server names are deliberately left visible, because a fully redacted error is useless, and an engineer who cannot diagnose from the log will go and reproduce the problem by hand, with a real credential, on a real terminal. Over-redaction has its own failure mode.

The scrubbed text is what is persisted, what is shown in the UI, and what is posted to the ServiceNow work note. All three read from the same scrubbed source: there is no path where one of them gets the raw version.

### 3.5 The AI boundary

The platform uses a language model to help parse written runbooks into structured configuration. That is a text-egress path, and it is treated as one. A separate, independent redaction layer sits in front of it and strips vault URLs, passwords, national identifiers, phone numbers, and email local parts before any text is sent. Secrets do not cross that boundary, and the boundary is a single choke point rather than a convention applied at each call site.

## 4. Why certificates for Microsoft 365

This question comes up in every review, so it gets its own section.

### 4.1 What a client secret actually is

A client secret is a password for an application. It is a bearer credential in the purest sense: possession is authentication. Whoever holds that string can authenticate as your application, from any machine, anywhere in the world, with no further proof required.

Three properties follow, and all three are bad:

- It is symmetric. The same value exists in your tenant and in our vault. There are two copies of the thing that grants access, and either one leaking is total.

- It travels. On every single token request, the secret itself is transmitted to Microsoft. It is transmitted over TLS, so this is not a practical interception risk, but the credential is nonetheless a value that moves across a network, sits in memory on both ends, and can end up in a proxy log, a crash dump, or an environment variable listing.

- It is replayable forever. A leaked client secret works until someone notices and rotates it. There is nothing about the secret that binds it to a time, a machine, or a request.

### 4.2 What a certificate changes

Certificate authentication is asymmetric, and that difference is the whole point.

Your tenant holds only the public half of the key pair. We hold the private half. To authenticate, the client constructs a short-lived assertion, a statement of who it is, who it is talking to, and when, and signs it with the private key. Microsoft verifies that signature using the public key it already has.

| Property | Client secret | Certificate |
| --- | --- | --- |
| Is the credential transmitted? | Yes, on every token request. | No. Ever. The private key never leaves the process that signs with it. Only the signature travels. |
| What is stored in your tenant? | Nothing that helps you, and a copy of the secret exists on both sides. | The public key. It is public. Stealing it from your tenant is worthless. |
| Can an intercepted authentication be replayed? | There is nothing to intercept but the secret itself, and the secret is total. | The signed assertion is single-use, time-bound, and audience-bound. Capturing one buys an attacker nothing. |
| What does a leak require? | One string. | The private key file and its password, both of which live in the vault, and neither of which is ever transmitted. |
| Rotation | Rotate and something breaks until every consumer is updated. | Two certificates can be registered simultaneously, so rotation has an overlap window and no outage. |

### 4.3 And for Exchange, it is not optional

Microsoft does not accept a client secret for Exchange Online app-only authentication. A certificate is the only supported mechanism. So for the Exchange portion of the estate this is not a preference we are defending, it is the only door, and Microsoft built it that way for exactly the reasons in the table above.

Because Exchange forces the issue, and because the certificate is strictly stronger, we use certificate authentication wherever the platform offers it: Exchange Online, Salesforce (which uses a signed JWT assertion, so no Salesforce password is ever stored anywhere), and Google Workspace (a signed service-account assertion, likewise no password).

### 4.4 How we handle the private key

A certificate is only stronger than a secret if the private key is handled better than a secret would be. So:

- The private key (a password-protected PFX) is held in the vault, encoded, alongside its password. It is not in the application, not in a repository, not in a configuration file, not in an environment variable.

- At execution, it is materialized to a randomly named temporary file only for the duration of the connection handshake, and deleted in a guaranteed cleanup path that runs whether the connection succeeded or failed.

- It is never installed into a certificate store on a Coretelligent host, so it cannot outlive the job that used it.

- You upload only the public certificate to your app registration. We never ask you to send us a private key, and you never need to hold ours.

If you run your own agent, the private key need never leave your network at all. Install the certificate into that host's own Windows certificate store and reference it by thumbprint. The platform then holds no copy of your Exchange private key in any form. For clients with a strict key-custody posture, this is the configuration we recommend.

### 4.5 Why an application registration, and never a Global Administrator account

People sometimes offer us a Global Admin service account instead, because it is quicker. We refuse, for two independent reasons.

The protocol reason: it cannot work. Entra’s client-credentials flow authenticates an application principal. A user account, however privileged, is not one. The attempt fails with AADSTS700016, "no application with that app id exists in this tenant," because the identifier being presented belongs to a person, not an application. This is not a limitation we can engineer around; it is what the grant type means. The platform actively detects a user account offered in an application slot and refuses it, rather than letting you discover this on your first live run.

The security reason: it would be far worse even if it did work.

|  | Global Admin account | App registration |
| --- | --- | --- |
| Privilege | Total, and unbounded. Everything in the tenant, forever. | A discrete, enumerable list of permissions, visible on one screen, each one justifiable. |
| Auditability | Actions blend in with every other administrative action. | Every action is attributable to a named non-human principal that does nothing else. |
| Revocation | Disabling it may break other things it was quietly used for. | Delete the app registration. Nothing else is affected. You can do this unilaterally, without telling us. |
| Interactive sign-in | It can sign in. It has a password a human can phish. | There is no interactive sign-in. There is nothing to phish. |
| Scope creep | It already has everything. | Adding a permission is a deliberate, consented, logged act by one of your administrators. |

### 4.6 The registration cannot grant itself permissions

Two Graph permissions, Application.ReadWrite.All and AppRoleAssignment.ReadWrite.All, allow an application to modify applications and consent to app roles. Together, they let an application grant itself further permissions, which makes any other permission boundary decorative: an app holding them is one API call away from being tenant admin.

We deliberately do not hold either of them, and we never will. This means that adding a Graph permission is always a manual, consented act by one of your Global Administrators. It makes our own setup slower. That is the point: it means the permission set you consent to on day one is the permission set we still have on day four hundred, and you do not have to take our word for that, you can read it off the API permissions screen.

This is a constraint we impose on ourselves, and we would encourage you to verify it rather than believe it. The consented permission list is visible to you, in your tenant, at any time, without our involvement.

### 4.7 Expiry

Client secrets expire. Certificates expire. An expiry that surprises you is an outage. The platform reads the expiry date from the vault and from the tenant itself, surfaces it on the client’s health view, and raises a notification ahead of the lapse, so rotation is a scheduled maintenance task rather than an incident. Rotation itself is currently a manual procedure; see section 12.

## 5. How runners authenticate

Two credentials, doing two different jobs.

### 5.1 The enrollment token

A new agent has no identity yet, so the endpoint that registers one cannot itself require an agent identity. That is a genuinely awkward bootstrap, and it is where a lot of platforms are weak.

The decision. Enrollment is authorized by a short-lived, HMAC-signed token minted in the UI and cryptographically bound to a specific scope and a specific client. It expires in an hour by default. Crucially, it is self-describing: the client it is for is inside the signed payload.

A token minted to enroll an agent for your organization can only ever enroll an agent for your organization. It cannot be replayed to register an agent somewhere else, or to register a central runner. Stealing it in transit buys an attacker the ability to do the one thing it was already going to be used for.

The signing key has no default value. If it is not configured, the platform refuses to mint or verify enrollment tokens at all rather than falling back to a known constant. A fallback would be worse than no control, because it would look like one.

### 5.2 The runner API token

Once enrolled, an agent presents a bearer token on every call. It is baked into the installer at the point of generation and written to the machine environment so the service can read it.

We will be precise about what this is and is not. It is a shared secret across the runner fleet, not a per-agent credential, and it is a bearer token, not a proof-of-possession one. Mutual TLS, where each agent presents a client certificate issued at enrollment, is the design we intend and have not yet shipped. It is in section 12. We are not going to describe the token as something it is not.

Retrieving that token inside the application is itself a privileged, audited action available only to senior administrators, and the audit records that it was retrieved and by whom, never the value.

### 5.3 The machine API fails closed

- A request to any runner endpoint without a valid token is rejected.

- If the token is not configured at all, those endpoints return a service error rather than opening. A missing configuration cannot become an open door.

- The endpoints that carry credentials fail closed in every environment, including development. There is no developer-convenience path that serves a tenant administrator credential to an unauthenticated caller.

#### Decision: the bootstrap exception is an allowlist, not a path prefix

A handful of endpoints must be reachable without a token, because a host that does not yet have a token has to fetch the installer. The lazy way to express that is "anything under this URL prefix is open." We did not do that.

The exception is an explicit list of four specific endpoints. The reason is a failure mode we wanted to make structurally impossible: with a prefix rule, a developer adding a new credential-carrying endpoint that happens to sit under the same URL path would expose it by accident, silently, with no code review signal. With an allowlist, a new endpoint is protected by default, and opening it requires deliberately adding it to a list whose name makes clear what you are doing.

## 6. Network posture

### 6.1 The guarantee

The agent inside your network makes outbound connections only. It polls the application over HTTPS, asks whether there is work, does the work, and reports back. It exposes no listening port. The platform holds no route into your network, no standing credential to it, and no mechanism to initiate a connection to it. No inbound firewall rule is required, and none should be created.

Why we chose polling over the alternatives. The obvious designs, a site-to-site VPN, a persistent tunnel, an inbound firewall exception to a listening agent, all create the same thing: a path from our environment into yours that exists whether or not anyone is using it. That path is an asset an attacker can find and take. Outbound polling has a real cost, latency, and a hard ceiling on how quickly we can react to something, and we paid it, because it means there is nothing to take.

The practical consequence is worth stating plainly: if you shut the agent down, we lose the ability to act in your network. We do not retain a back door, because there is not one to retain. That is a property you can verify from your own side, with a firewall log, without trusting anything we have written here.

### 6.2 Transport

- All communication with your SaaS systems, with the vault, and with Entra is over HTTPS.

- There is no certificate-validation bypass anywhere in the codebase, not in the runner, not in the application, not behind a debug flag. Certificate validation is never disabled. This is a claim you can audit, and one we check for.

- The runner sets a TLS 1.2 floor.

Where we are, stated honestly. The platform is running as a pilot from a Coretelligent-hosted endpoint. The production move (Azure Container Apps, a single stable HTTPS endpoint with a managed certificate, platform secrets held in Azure Key Vault via managed identity) is the next scheduled work item, and is what every agent will poll once it lands. We would rather set out where we are than imply a posture we are still building.

## 7. How operators authenticate

### 7.1 Sign-in

Coretelligent staff sign in with Microsoft Entra SSO, OpenID Connect, authorization code flow with PKCE, against Coretelligent's own tenant. That means our own conditional access, our own MFA policy, and our own joiner/leaver process govern who can reach the platform, and revoking a Coretelligent employee's account revokes their access to your data as a side effect of the normal leaver process, rather than as a separate step someone has to remember.

A local break-glass account exists for the case where SSO itself is the outage. Its password is stored as a salted scrypt hash, a deliberately memory-hard function, chosen because it makes offline cracking of a stolen hash expensive rather than merely inconvenient, and verified in constant time. Its use is audited under its own distinct event type, so break-glass usage is visible rather than blending into normal sign-ins.

### 7.2 Decision: opaque sessions, not JWTs

The problem with a JWT session. A signed token is self-validating, which is exactly what makes it convenient and exactly what makes it hard to revoke. The server does not need to look it up, so the server also has no natural point at which to refuse it. Genuine revocation requires bolting a denylist onto a design whose entire selling point was not needing one.

The decision. A session is an opaque, high-entropy random value in an HTTP-only, same-site, secure cookie. The server stores only its SHA-256 hash.

- Revocation is immediate and real, because every request looks the session up. Disabling a user atomically revokes every live session that user holds, in the same transaction. Changing a password revokes every other session.

- A database disclosure yields nothing replayable. The stored hash cannot be used to authenticate; an attacker with a full dump of the session table cannot sign in as anyone.

- Sessions expire after 12 hours.

### 7.3 Roles, permissions, and separation of duties

Authorization is checked against permissions, not role names, at every server-side entry point. Six roles map onto twelve permissions. The separations that matter:

- An engineer can plan and run cases but cannot approve destructive steps. The person doing the work is not the person authorizing the irreversible part of it.

- An auditor is strictly read-only.

- An importer can bring cases in but not execute them.

- Granting or removing the highest role is restricted to that role. An administrator cannot promote themselves out of a control, and cannot demote a peer in order to reset their password and inherit their access.

### 7.4 Decision: client scoping is a server boundary, and it returns 404

Each operator’s access to clients is all, an explicit allowlist, or all-except-a-denylist. Individual clients can be marked restricted, requiring an explicit grant on top. An operator who is scoped away from a restricted client cannot confer access to it: you cannot grant what you cannot see.

Two decisions inside that are worth calling out.

It is enforced in the data queries, not in the UI. Hiding a client from a list is not a security boundary if the API still answers a guessed URL. The scope is applied where the data is fetched.

A request for a client outside your scope returns "not found," not "forbidden." Forbidden is an admission that the thing exists. An operator, or an attacker with an operator’s session, could enumerate our entire client list by probing URLs and sorting 403s from 404s. So the boundary does not merely deny; it declines to confirm.

### 7.5 "View as" is read-only

A super-administrator can view the application as another user to reproduce an access problem. While doing so, every mutation is refused. It is a lens, not a login: it cannot be used to take an action while wearing someone else's identity, which would be the one thing that makes impersonation genuinely dangerous. It also cannot be nested.

## 8. Preventing the platform from doing harm

The threats in this section are not attackers. They are us: the platform doing something catastrophic because of a bug, a bad intake form, or a misconfiguration. For an automation system with this much privilege, this is at least as likely as a breach, and the controls are as deliberate.

### 8.1 Idempotency

Every executor checks state before it changes it. A step re-run after a partial failure converges on the same end state rather than creating a duplicate, a conflict, or a second identity. This is what makes automatic retry safe, and a system that cannot safely retry is a system that fails half-way and leaves a human to work out what it did.

### 8.2 Dry run

Any case can be executed read-only. Every step connects for real, reads for real, and reports exactly what it would change, and writes nothing. This is the recommended first run for any newly configured client.

The mode is enforced at the moment a job is handed to a runner, reading from the case rather than a stamp on the job. That closes a real race: a job claimed while someone is toggling the mode cannot end up executing live against a case that is still marked dry-run.

### 8.3 The approval gate is at dispatch, not in the UI

Steps are classified at plan time by intent. Anything destructive (deleting a mailbox, hard-deleting an identity, shutting down a device) always requires approval and always captures evidence.

That classification cannot be switched off by configuration, and the gate is enforced where the job is handed to a runner, not in the interface. An unapproved destructive job is never given to a runner at all, no matter what any screen does, what any API is called directly, or what any UI defect permits. A control that lives in the UI is a suggestion.

The approver’s identity is recorded automatically from their authenticated session. It is not a free-text field someone types a name into.

### 8.4 Evidence precedes removal

On the offboard path, group memberships and application assignments are captured and attached to the case before they are removed. The record of what someone had survives the removal of what they had. If a termination is disputed, or the person is reinstated, or an auditor asks what access existed on a given date, the answer is on the case, not reconstructed from memory.

### 8.5 Guardrails encode the client-specific hazards

Some things are dangerous only at a particular client, and the knowledge normally lives in one engineer's head. We encode them:

- do-not-move-ou: at tenants where moving an AD object into a Disabled OU takes it out of sync scope and deletes the cloud user. The step disables in place instead. This guardrail exists because the failure it prevents is unrecoverable.

- do-not-delete: the identity is disabled and retained, never removed.

- no-device-wipe-without-approval: endpoint destruction is always gated.

### 8.6 The scheduler refuses more than it accepts

Offboards can be scheduled automatically from the termination date on the ticket. The interesting part is when it declines to, and holds the case for a human:

- The date is ambiguous (a date with no time): there is no instant to fire against, and guessing one is how you offboard someone eight hours early.

- The date is already in the past. A backdated ticket must never fire an unwatched destructive run. This also means that turning the feature on for the first time cannot cause a stampede of historical offboards.

- The date is implausibly far out: a mis-keyed year is a real thing that happens.

- The target identity could not be resolved with confidence. An offboard that is not certain who it is offboarding never runs unattended. Ever.

Time arithmetic is done in absolute instants, so a server timezone or a daylight-saving transition cannot move when something fires.

### 8.7 Capability routing withholds rather than fails

Each runner reports what it is actually able to do. A job whose requirements no available runner meets waits, with a stated reason, rather than being dispatched to a runner that will fail half-way through it. A step that fails part-way through an identity chain is a much worse outcome than a step that never started.

### 8.8 Containment controls

| Control | Effect |
| --- | --- |
| Disable an agent | Immediately refused for claiming work, brokering credentials, and posting results, enforced mid-flight, not just at claim time. A compromised or misbehaving agent can be cut out of the fleet in one action. |
| Stop a job | The job is halted and late results from the runner are rejected, so the stop holds. |
| Pause or cancel a case | A paused case's steps are never claimed by any runner. Cancel aborts every in-flight step. |
| Disable a user | Atomically revokes every live session that user holds, in the same transaction. |
| Revoke a session | Immediate: every request revalidates against the session store. |

## 9. Credential delivery to the new starter

The last mile of onboarding is where good credential hygiene usually dies: a password typed into a chat message, an email, a ticket comment.

### 9.1 The one-time reveal

Initial passwords are generated with a cryptographic random number generator, never a predictable one, at 16 characters across four character classes, excluding visually ambiguous glyphs.

The value is shown to an operator exactly once, and is destroyed at the moment it is revealed. The reveal is an atomic claim: if two people open the case simultaneously, exactly one of them sees the password, and the other is told plainly that it has already been revealed and cannot be recalled. There is no race in which both see it, and no path by which a second person can quietly retrieve it later.

It is never written to the run log, the audit record, or the ServiceNow work note. The audit records that a password was revealed, and by whom, never what it was.

### 9.2 Better: no password at all

Where your tenant supports it, we prefer to issue no password. A Temporary Access Pass lets the new starter register their own credentials and MFA factors directly with Entra. Nothing reusable ever transits a human being, a chat client, or a ticket. This is the configuration we recommend, and it removes the last-mile problem rather than managing it.

## 10. Threat model

The honest test of a design is not the list of its controls but what actually happens when one of them fails. Each row assumes total compromise of the thing named, and states what the attacker gets, and what still stands between them and your estate.

| If an attacker fully compromises... | What they get | What stops them |
| --- | --- | --- |
| The agent host in your network (SYSTEM on a domain controller) | The credentials for jobs executing on that host in that moment, and nothing else. No vault access. No standing credential. Nothing about any other client. | The runner holds no vault credentials and cannot reach the vault. Credentials are brokered per job, checked against job ownership and a per-job secret allowlist. An operator can disable the agent instantly, which cuts it off mid-flight. |
| The runner API token | The ability to impersonate a runner: claim jobs and request the credentials for those specific jobs. This is the most valuable single artifact in the system, and we treat it that way. | It is disclosed only to senior administrators, and the disclosure is audited. Credentials are still constrained to jobs and their allowlists; the token does not open the vault. Per-agent credentials and mutual TLS are the fix, and are in section 12. |
| The application database | Your client configuration, case history, and a list of vault reference IDs. Not one credential. Not a replayable session. | Secrets are references only; the schema cannot hold a value. Sessions are stored as SHA-256 hashes. Operator passwords are scrypt-hashed. |
| An operator's laptop / live session | That operator's permissions, on that operator's clients, for up to 12 hours. | Per-client scoping is a server boundary. Destructive steps still need an approval the operator may not hold. Disabling the user revokes every session atomically. Every action they take is attributed to them in the audit log. |
| One SaaS credential (say, your Zoom app) | Zoom. That is the whole blast radius. | Each system has its own credential, scoped to that system, in its own vault entry. There is no master credential, and no credential that unlocks a second system. |
| A Coretelligent operator turning malicious | Whatever their role permits, on the clients they are scoped to. | Separation of duties: an engineer cannot approve the destructive steps of the case they are running. Every action is attributed and append-only logged. Evidence is captured before removal. Client scoping bounds which clients they can touch at all. |
| The vault | This is the crown jewel, and we do not pretend otherwise. | It is a dedicated, hardened, separately credentialed secrets management platform, not a table in our database. The application's vault account is used for reads at execution time; each access is logged in the vault's own audit trail, which is outside the application and cannot be edited from it. |

### What we want you to take from this table

The layer most likely to be attacked (the agent sitting on a domain controller inside a network we do not control and cannot see) is the layer we gave the least to steal. That is not an accident, and it is the reason the push-down brokering decision in section 3.2 was worth its cost.

## 11. Application security

### 11.1 Injection

ServiceNow query injection, guarded. ServiceNow’s query language treats ^ as an operator, which means an unvalidated identifier interpolated into a query can inject conditions and return records the caller was never entitled to. We validate identifiers against positive allowlist patterns that fail closed: a value that does not match is rejected outright rather than passed through in a degraded form. This is regression-tested with a real injection string.

Directory query injection, guarded. Values interpolated into Microsoft Graph and Active Directory filters are escaped. The motivating case is not an attacker at all, it is an employee named O'Brien, but the same escape closes both.

SQL injection, structurally prevented. All database access is through a parameterizing query layer. There is no string-concatenated SQL anywhere in the codebase, and none of the unsafe raw-query escape hatches are used.

Cross-site scripting, structurally prevented. The UI renders through a framework that escapes by default, and the codebase contains no raw-HTML injection sinks at all, so runbook and intake content, which is the untrusted text in this system, has no path to execute.

### 11.2 The runner update path

Agents update themselves: the application publishes the current runner build, and an agent that is behind fetches the changed files and restarts. This is what lets us patch a fleet across two hundred client networks without asking anyone for remote access to a domain controller, a genuine security benefit, and the reason it works this way.

It is also, necessarily, a code distribution channel into your network, and we are going to be direct about the state of it. The channel is authenticated and encrypted: the endpoints require the runner token, they are served over TLS, and the file endpoint is guarded against path traversal. But the bundle is not yet cryptographically signed, which means the integrity of what an agent executes currently rests on the integrity of the application server and the confidentiality of the runner token, rather than on a signature the agent can verify independently.

Signed runner bundles are our highest-priority security work item, and are listed as such in section 12. A security reviewer should ask about this; we would rather answer it here than be asked. Until it ships, the compensating controls are the ones named above, plus the fact that an agent can be disabled centrally and instantly.

## 12. What is not done

Everything above is implemented and in force today. This section is what is not, ranked by how much it matters. We publish it because a security document you cannot trust the boundaries of is worse than no document.

| Item | Where we are | Priority |
| --- | --- | --- |
| Cryptographically signed runner bundles. The agent should verify a signature over the code it is about to execute, rather than trusting the channel it arrived on. | Not shipped. The update channel is token-authenticated and TLS-encrypted, and the file endpoint is traversal-guarded, but the agent cannot independently verify integrity. See section 11.2. | Highest. In progress. |
| Mutual TLS and per-agent credentials. Each agent should present its own client certificate, issued at enrollment, instead of a bearer token shared across the fleet. | Not shipped. Enrollment is already bound per-client by a signed, short-lived token; that half is done. The per-agent identity half is not. | High |
| Encrypted database backups. Nightly backups are compressed but not encrypted at rest, and are held on the application host. | Not shipped. | High, and cheap. Being fixed now. |
| Automated credential rotation. Rotating the runner token today is a configuration change plus a re-run of the installer on each host. | Not shipped. Expiry of tenant credentials is monitored and alerted; see section 4.7. | Medium |
| Rate limiting and account lockout on the operator sign-in endpoint. Failed sign-ins are audited with the source address, but nothing throttles them. | Not shipped. The exposure is limited to break-glass local accounts; SSO accounts cannot be password-attacked through this path at all. | Medium, and cheap. |
| A data retention policy. The ServiceNow intake payload, which contains personal data about your employees, is currently retained for the life of the case record, with no scheduled minimization after the case completes. | Not shipped. We are defining a policy that scrubs the personal fields once a case is closed and the automation no longer needs them, while retaining the audit trail and outcome. | Medium. See section 13. |
| Azure hosting with a managed TLS certificate and platform secrets in Azure Key Vault via managed identity. | Roadmap; the next scheduled infrastructure work. | Medium |

## 13. Data handling

### 13.1 What the platform holds about your people

The engine stores the ServiceNow intake form for each case, because that is what it executes from. For an onboarding, that includes the new starter's name, job title, department, manager, office, start date, and, where your intake form collects them, personal contact details. For an offboarding, it includes the leaver's identity, the termination date, mailbox delegation instructions, and the HR context fields your form carries.

We are telling you this because you should ask. These are records about your employees, some of them sensitive, and they live in our system for as long as the case record does. As noted in section 12, a scheduled minimization policy, scrubbing the personal fields once a case is complete and the automation no longer needs them, while retaining the audit trail, is defined but not yet shipped. If you have a retention requirement, tell us and we will hold your data to it.

### 13.2 What it deliberately does not hold

- No credential values. References only. The schema cannot hold a value.

- No replayable sessions. Only session hashes.

- No reversible operator passwords. Scrypt hashes only.

- No standing credentials on any agent, in any client network.

## 14. What you control

Everything in this list you can do unilaterally, at any moment, without our involvement and without our permission. This is deliberate: a security posture that depends on the vendor cooperating in their own lockout is not a security posture.

- Revoke our access to your tenant entirely. Delete the application registration. Nothing else in your tenant is affected.

- Reduce our permissions. Remove a Graph permission and the corresponding step will fail loudly rather than degrade silently.

- Read exactly what we are consented to. The permission list is in your tenant, on one screen, at all times. You do not have to take this document’s word for it.

- Cut off all activity in your network. Stop the agent service, or block its outbound address. There is no second path in.

- Rotate any credential. Every one of them is in your system, created by you.

- Audit what we did. In your own logs. Every action the engine takes appears in your tenant's audit trail as an action by a named, non-human application principal that does nothing else.

### Closing

The engine holds a great deal of privilege, and the correct response to that is not reassurance, it is architecture that limits what the privilege is worth to anyone who takes it. The credential the platform does not store cannot be stolen from it. The vault the agent cannot reach cannot be reached through the agent. The permission the app registration cannot grant itself cannot be escalated into. And the step that cannot be dispatched without an approval cannot be executed by a bug.

Questions, and any control in this document you would like evidenced rather than asserted, to your Coretelligent engagement contact. We would rather be audited than believed.
