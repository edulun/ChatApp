import { useAppDispatch, useAppSelector } from './hooks';
import { signedOut } from './features/auth/authSlice';
import { useListRoomsQuery } from './api/roomsApi';
// Registers roomsApi's endpoints on the shared api slice (baseApi.ts) — importing it is enough,
// see the note in store.ts. authApi/messagesApi aren't used by this minimal shell yet, but follow
// the same pattern when a component needs them.

function SignedOutView() {
  return (
    <main>
      <h1>ChatApp</h1>
      {/* TODO: Google Identity Services sign-in flow (ChatApp-Client/DESIGN.md §3) needs a real
          registered OAuth client ID, which doesn't exist yet — stubbed rather than half-wired to
          something untestable. Once one exists: load the GIS script, render its button, and on
          credential response call useAuthGoogleMutation() (src/api/authApi.ts) then dispatch
          signedIn({ user, token }) from the response. */}
      <button type="button" disabled>
        Sign in with Google (not configured yet)
      </button>
    </main>
  );
}

function RoomList() {
  const { data, isLoading, error } = useListRoomsQuery();

  if (isLoading) return <p>Loading rooms…</p>;
  if (error) return <p>Failed to load rooms.</p>;

  return (
    <ul>
      {data?.rooms.map((room) => (
        <li key={room.id}>{room.name ?? room.id}</li>
      ))}
    </ul>
  );
}

function SignedInView() {
  const dispatch = useAppDispatch();
  const user = useAppSelector((state) => state.auth.user);

  return (
    <main>
      <header>
        <h1>ChatApp</h1>
        <p>
          Signed in as {user?.displayName}{' '}
          <button type="button" onClick={() => dispatch(signedOut())}>
            Sign out
          </button>
        </p>
      </header>
      <RoomList />
    </main>
  );
}

function App() {
  const isSignedIn = useAppSelector((state) => state.auth.token !== null);
  return isSignedIn ? <SignedInView /> : <SignedOutView />;
}

export default App;
