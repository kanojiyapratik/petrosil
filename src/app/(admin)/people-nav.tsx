/**
 * Where you are inside People: the way back to its overview, and its five
 * screens side by side. Before this, Customers, Trial requests, the team,
 * roles and sign-ins could each be reached only from the People overview,
 * and none of them linked to the others.
 */

import Link from "next/link";

import { PEOPLE_TABS } from "./nav";
import { SubTabs } from "./subtabs";

export function PeopleNav() {
  return (
    <>
      <nav className="crumbs" aria-label="Where you are">
        <Link href="/dashboard/people">People</Link>
      </nav>
      <SubTabs items={PEOPLE_TABS} label="People screens" />
    </>
  );
}
