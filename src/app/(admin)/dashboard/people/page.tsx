/**
 * People.
 *
 * The owner's wording was "the entire user flow: self-registered subscribers
 * AND Petrosil team users", and the reason it is one place is in the data: a
 * person is **one** record, while what they may read is **per brand**. 87,884
 * people hold 96,424 memberships, and 6,609 of them read more than one brand
 * — a set no one of the nine old admins could see, because each read only its
 * own database.
 *
 * The old sidebar spread this across eleven entries in two groups: seven
 * Directory filters, then Users, Roles and the login log somewhere else
 * entirely, with the trial queue reachable from no menu at all. Here it is
 * one place with five tabs, and this page links to the screens that already
 * do each job rather than reimplementing them.
 */

import Link from "next/link";

import { currentViewer } from "@/lib/auth/server";
import { segmentCounts } from "@/domain/dashboard/clients";
import { PEOPLE_TABS } from "../../nav";
import { Heading, Panel, Tile } from "../../ui";

export const metadata = { title: "People · Petrosil" };
export const dynamic = "force-dynamic";

const WHAT: Record<string, string> = {
  customers: "Everyone who signed themselves up, with what each one may read.",
  trials: "Free trials waiting on a decision. Approving one grants a trial that expires on its own.",
  team: "Petrosil staff accounts — the people who hold a role in this admin.",
  roles: "What each role can do. Estate-wide: one person, one role, across every brand.",
  logins: "Who signed in, when, and from where.",
};

export default async function PeoplePage() {
  const viewer = (await currentViewer())!;
  const counts = await segmentCounts(viewer.siteIds);
  // Every standing added together: the segments are exclusive, so this is the
  // customer book. Staff are counted separately and are not customers.
  const customers =
    counts.premium + counts.trial + counts.expired + counts.trial_expired + counts.free;

  return (
    <>
      <Heading
        title="People"
        sub={
          "Everyone in one place — the customers who signed themselves up and the Petrosil " +
          "team. A person is one record; what they can read is per brand."
        }
      />

      <div className="tiles">
        <Tile n={customers} k="customers" />
        <Tile n={counts.premium} k="paying" />
        <Tile n={counts.trial} k="on trial" />
        <Tile n={counts.expired} k="lapsed" />
        <Tile n={counts.trial_expired} k="trial over" />
        <Tile n={counts.free} k="free" />
      </div>

      <div className="modgrid">
        {PEOPLE_TABS.map((tab) => (
          <Link key={tab.slug} href={tab.href} className="mod">
            <strong>{tab.label}</strong>
            <span>{WHAT[tab.slug]}</span>
          </Link>
        ))}
      </div>

      <Panel title="Two things worth knowing about this list" flush={false}>
        <ul className="plain">
          <li>
            A person is one record across the estate, but their standing is held per brand —
            so someone can be paying on one brand and lapsed on another, and both are true.
          </li>
          <li>
            On the old sites, a trial that expired kept full paying access: the paywall read
            the account&rsquo;s type and never looked at the date. Here an expired trial is
            expired, which is why these figures differ from the old screens&rsquo;.
          </li>
        </ul>
      </Panel>
    </>
  );
}

