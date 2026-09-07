import type { ReactNode } from "react";
import { ConnectionRequestsProvider } from "@/hooks/use-connection-requests";
import { ConnectionSettingsProvider } from "@/hooks/use-connection-settings";
import { BackendRequestsProvider } from "@/hooks/use-worker-backend-requests";
import { ModelsRequestsProvider } from "@/hooks/use-worker-models-requests";
import { NodesRequestsProvider } from "@/hooks/use-worker-nodes-requests";
import { SetupRequestsProvider } from "@/hooks/use-worker-setup-requests";
import { ConnectionDialogsProvider } from "./ConnectionDialogs";

export function ConnectionProvider({
	children,
	closeRequest,
}: {
	children: ReactNode;
	closeRequest: number;
}): React.JSX.Element {
	return (
		<ConnectionSettingsProvider>
			<ConnectionRequestsProvider>
				<BackendRequestsProvider>
					<NodesRequestsProvider>
						<ModelsRequestsProvider>
							<SetupRequestsProvider>
								<ConnectionDialogsProvider closeRequest={closeRequest}>
									{children}
								</ConnectionDialogsProvider>
							</SetupRequestsProvider>
						</ModelsRequestsProvider>
					</NodesRequestsProvider>
				</BackendRequestsProvider>
			</ConnectionRequestsProvider>
		</ConnectionSettingsProvider>
	);
}
