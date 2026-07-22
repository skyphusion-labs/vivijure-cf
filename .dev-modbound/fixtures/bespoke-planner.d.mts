type DevFixtureWorker = {
  fetch(request: Request): Promise<Response>;
};

declare const worker: DevFixtureWorker;
export default worker;
