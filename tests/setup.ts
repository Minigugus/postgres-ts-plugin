import postgres from 'postgres';

export default postgres({
  types: {
    bigint: postgres.BigInt
  }
});
