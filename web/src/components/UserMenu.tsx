import type { DemoUser } from "../types";
import { DropdownMenu } from "./DropdownMenu";

export function UserMenu(props: { user: DemoUser; onSignOut: () => void }) {
  return <DropdownMenu label={`Account menu for ${props.user.username}`} triggerClass="signed-in-chip profile-trigger" trigger={<>
    <span class="user-avatar">{props.user.username.slice(0, 1).toUpperCase()}</span>
    <span class="profile-name">{props.user.username}</span><span aria-hidden="true">⌄</span>
  </>}>
    <button type="button" role="menuitem" onClick={props.onSignOut}>Log out</button>
  </DropdownMenu>;
}
