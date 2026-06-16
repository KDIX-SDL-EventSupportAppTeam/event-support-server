export class SampleDataConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SampleDataConflictError'
  }
}
